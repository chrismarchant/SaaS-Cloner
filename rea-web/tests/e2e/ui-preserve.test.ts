/**
 * The Preserve & restore workflow driven through the built web UI in a real
 * browser: declare a build from the preservation fixture, plan it, capture
 * it, verify it by restoring it, and export it plain and encrypted. The UI is
 * served from the API origin, a real runner (separate process) holds the
 * capture and restore credentials, and the API is consulted only to
 * cross-check what the page shows. Every step is a click or a keystroke.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateRecoveryKey,
  unpackExport,
  verifyIntegrity,
} from "@rea-web/recovery";
import {
  createFixtureBuild,
  DB_ENV_NAME,
  fullBuild,
  type FixtureBuild,
} from "../../packages/preservation/test/fixtureBuild.js";
import { localPathHash } from "../../apps/runner/src/preservation/localPaths.js";
import { REA_WEB_ROOT, Stack, stackUnavailableReason } from "./stack.js";

const CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const WEB_DIST = join(REA_WEB_ROOT, "apps/web/dist");

const unavailableReason = (): string | null => {
  const stackReason = stackUnavailableReason();
  if (stackReason) return stackReason;
  if (!existsSync(join(WEB_DIST, "index.html")))
    return `${WEB_DIST}/index.html is missing; run npm run build -w @rea-web/web (rea-web)`;
  if (!existsSync(CHROMIUM)) return `${CHROMIUM} is missing`;
  return null;
};

const unavailable = unavailableReason();
if (unavailable) console.warn(`e2e skipped: ${unavailable}`);
const describeUi = unavailable ? describe.skip : describe;

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const text = async (locator: Locator): Promise<string> =>
  (await locator.textContent()) ?? "";

/** Polls a page read until the assertion holds (vitest has no locator matchers). */
const eventually = <T>(read: () => Promise<T>, timeout = 30_000) =>
  expect.poll(read, { timeout, interval: 250 });

const JOB_TIMEOUT = 300_000;

describeUi("preserve and restore workflow through the web UI", () => {
  const stack = new Stack();
  const recoveryKey = generateRecoveryKey();
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let scratch = "";
  let fx: FixtureBuild;
  let project = "";
  let runnerId = "";
  let buildId = "";
  let captureId = "";
  let captureUrl = "";
  const pageErrors: string[] = [];
  const cspViolations: string[] = [];

  /** Cross-checks go through the API with the browser's own session cookie. */
  const api = async <T = any>(path: string): Promise<T> => {
    stack.cookie = (await context.cookies())
      .filter((cookie) => cookie.name === "rea_web_session")
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
    const response = await stack.request<T>("GET", path);
    expect(response.status, `${path}: ${response.text}`).toBe(200);
    return response.json;
  };

  /** The page text never holds a secret from the fixture or its database. */
  const expectNoSecrets = async (): Promise<void> => {
    const content =
      (await page.content()) + (await page.locator("body").innerText());
    expect(content).not.toContain(fx.secretMarker);
    expect(content).not.toContain(fx.databasePassword);
    expect(content).not.toContain(recoveryKey.keyBase64);
  };

  const gotoCapture = async (): Promise<void> => {
    await page.goto(captureUrl);
    await page.getByTestId("capture-status").waitFor();
  };

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "rea-web-ui-preserve-"));
    fx = await createFixtureBuild(join(scratch, "fx"));
    await stack.start({ staticDir: WEB_DIST });
    browser = await chromium.launch({
      executablePath: CHROMIUM,
      args: ["--no-sandbox"],
    });
    context = await browser.newContext({ acceptDownloads: true });
    page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (/content security policy/iu.test(message.text()))
        cspViolations.push(message.text());
    });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await stack.stop();
    await fx?.cleanup();
    await rm(scratch, { recursive: true, force: true });
  });

  it("registers, creates a runner in the UI and starts it with the fixture's environment", async () => {
    await page.goto(stack.apiUrl);
    await page.getByRole("button", { name: "Register" }).click();
    await page.getByLabel("Email").fill("ui-preserver@example.test");
    await page.getByLabel("Password").fill("correct horse battery");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByRole("link", { name: "Runners" }).waitFor();
    project =
      (await api<{ items: { id: string }[] }>("/projects")).items[0]?.id ?? "";

    await page.getByRole("link", { name: "Runners" }).click();
    await page.getByLabel("Runner name").fill("ui-preserve-runner");
    await page.getByRole("button", { name: "Create runner" }).click();
    const token = page.getByTestId("runner-token");
    await token.waitFor();
    const runnerToken = await token.inputValue();
    await page.getByRole("button", { name: "I have stored the token" }).click();

    const keysDir = join(scratch, "keys");
    await mkdir(keysDir, { mode: 0o700 });
    await writeFile(
      join(keysDir, `${recoveryKey.keyId}.key`),
      recoveryKey.keyBase64,
      {
        mode: 0o600,
      },
    );
    stack.startRunner(runnerToken, {
      REA_WEB_RECOVERY_KEYS_DIR: keysDir,
      REA_WEB_VERIFY_DATABASE_ADMIN_URL: fx.adminDatabaseUrl,
      REA_WEB_VERIFY_ALLOW_NETWORK: "registry",
      REA_WEB_RUNNER_LOCAL_TARGET_ALLOWLIST: `${fx.repoPath}:${fx.assetsPath}`,
      // The capture credential lives only on the runner, under the declared name.
      [DB_ENV_NAME]: fx.databaseUrl,
    });
    const row = page
      .getByTestId("runner-row")
      .filter({ hasText: "ui-preserve-runner" });
    await row
      .getByText("online", { exact: true })
      .waitFor({ timeout: 120_000 });
    runnerId =
      (
        await api<{ items: { id: string; name: string }[] }>(
          `/projects/${project}/runners`,
        )
      ).items.find((runner) => runner.name === "ui-preserve-runner")?.id ?? "";
    expect(runnerId).not.toBe("");
  }, 300_000);

  it("shows an empty Preserve list and refuses a bad build before sending it", async () => {
    await page
      .getByLabel("Primary")
      .getByRole("link", { name: "Preserve" })
      .click();
    await page.getByRole("heading", { name: "Preserve & restore" }).waitFor();
    await page
      .getByText("No build has been declared in this project.")
      .waitFor();

    await page.getByRole("link", { name: "New build" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Refused build");
    await page
      .getByLabel("Repository URL")
      .fill("https://user:hunter2@example.test/app.git");
    await page.getByText("This URL embeds a password.").waitFor();
    await page.getByLabel("Component kind to add").selectOption("data");
    await page.getByRole("button", { name: "Add component" }).click();
    const data = page.getByRole("group", { name: "Component 2: data" });
    await data.getByLabel("Component 2 id").fill("db");
    await data
      .getByLabel("Connection variable NAME")
      .fill("postgres://nobody:hunter2@db.example.test/app");
    await page
      .getByLabel("Component kind to add")
      .selectOption("infrastructure");
    await page.getByRole("button", { name: "Add component" }).click();
    const infra = page.getByRole("group", {
      name: "Component 3: infrastructure",
    });
    await infra.getByLabel("Component 3 id").fill("infra");
    await infra.getByLabel("Descriptor (JSON object)").fill("{ not json");
    await page.getByRole("button", { name: "Create build" }).click();

    const alert = page
      .getByRole("alert")
      .filter({ hasText: "The build was not sent" });
    await alert.waitFor();
    const problems = await text(alert);
    expect(problems).toContain("components.1.connection_env_name");
    expect(problems).toContain("components.2.descriptor");
    expect(problems).toContain("Not valid JSON");
    // Nothing was stored: the contract refused it in the browser.
    expect(
      (await api<{ items: unknown[] }>(`/projects/${project}/builds`)).items,
    ).toEqual([]);
  });

  it("declares the fixture build with a picked source path, a pasted assets hash, a data invariant and a JSON descriptor", async () => {
    const declared = fullBuild(fx);
    const repoHash = localPathHash(await realpath(fx.repoPath));
    const assetsHash = localPathHash(await realpath(fx.assetsPath));
    const infra = declared.components.find((c) => c.kind === "infrastructure");
    expect(infra).toBeDefined();

    // The runner registered its allowlisted paths as targets the form can pick.
    const targets = await api<{ items: any[] }>(`/projects/${project}/targets`);
    const repoTarget = targets.items.find(
      (t) => t.kind === "runner_local" && t.path_hash === repoHash,
    );
    expect(repoTarget, JSON.stringify(targets.items)).toBeDefined();

    await page.goto(`${stack.apiUrl}/preserve/new`);
    await page.getByLabel("Name", { exact: true }).fill(declared.name);
    await page.getByLabel("Description").fill(declared.description);
    await page.getByLabel("Source kind").selectOption("runner_local");
    await page
      .getByLabel("Source path: allowlisted path")
      .selectOption(repoTarget.id);
    await page.getByText(repoHash).first().waitFor();

    const add = async (kind: string): Promise<void> => {
      await page.getByLabel("Component kind to add").selectOption(kind);
      await page.getByRole("button", { name: "Add component" }).click();
    };
    await add("dependencies");
    const deps = page.getByRole("group", { name: "Component 2: dependencies" });
    await deps.getByLabel("Component 2 id").fill("deps");
    await deps.getByLabel("Container images").fill("redis:7");

    await add("data");
    const data = page.getByRole("group", { name: "Component 3: data" });
    await data.getByLabel("Component 3 id").fill("db");
    await data.getByLabel("Connection variable NAME").fill(DB_ENV_NAME);
    await data.getByRole("button", { name: "Add invariant" }).click();
    await data.getByLabel("Invariant 1 id").fill("notes-count");
    await data.getByLabel("Invariant 1 SQL").fill("select count(*) from notes");
    await data.getByLabel("Invariant 1 expected value").selectOption("number");
    await data.getByLabel("Invariant 1 expected", { exact: true }).fill("3");

    await add("assets");
    const assets = page.getByRole("group", { name: "Component 4: assets" });
    await assets.getByLabel("Component 4 id").fill("uploads");
    await assets
      .getByLabel("Assets path: allowlisted path")
      .selectOption("__manual");
    await assets.getByLabel("Assets path: runner").selectOption(runnerId);
    await assets.getByLabel("Assets path: path hash").fill(assetsHash);

    await add("infrastructure");
    const infrastructure = page.getByRole("group", {
      name: "Component 5: infrastructure",
    });
    await infrastructure.getByLabel("Component 5 id").fill("infra");
    await infrastructure
      .getByLabel("Descriptor (JSON object)")
      .fill(
        JSON.stringify((infra as { descriptor: unknown }).descriptor, null, 2),
      );

    await page.getByRole("button", { name: "Create build" }).click();
    await page.waitForURL(/\/preserve\/builds\/[0-9a-f-]{36}$/u);
    buildId = page.url().match(/builds\/([0-9a-f-]{36})/u)?.[1] ?? "";
    expect(await text(page.getByTestId("build-name"))).toBe(declared.name);
    await eventually(() =>
      page.getByTestId("definition-component").count(),
    ).toBe(5);

    const stored = await api<any>(`/projects/${project}/builds/${buildId}`);
    expect(stored.source).toMatchObject({
      kind: "runner_local",
      runner_id: runnerId,
      path_hash: repoHash,
    });
    expect(stored.components.map((c: any) => `${c.kind}:${c.id}`)).toEqual([
      "source:main",
      "dependencies:deps",
      "data:db",
      "assets:uploads",
      "infrastructure:infra",
    ]);
    expect(stored.components[3].source).toMatchObject({
      kind: "runner_local",
      runner_id: runnerId,
      path_hash: assetsHash,
    });
    expect(stored.components[2]).toMatchObject({
      connection_env_name: DB_ENV_NAME,
      invariants: [
        { id: "notes-count", sql: "select count(*) from notes", expect: 3 },
      ],
    });
    // The page shows the variable NAME and never the credential behind it.
    expect(await text(page.locator("main"))).toContain(DB_ENV_NAME);
    await expectNoSecrets();
  });

  it("plans the build and shows each component's feasibility, checks, method and size", async () => {
    await page.getByRole("button", { name: "Create plan" }).click();
    await page.waitForURL(/\/plans\/[0-9a-f-]{36}$/u);
    const components = page.getByTestId("plan-component");
    await eventually(() => components.count(), JOB_TIMEOUT).toBe(5);

    const card = (id: string) =>
      components.filter({
        has: page.locator("h3 code", { hasText: new RegExp(`^${id}$`, "u") }),
      });
    for (const id of ["source:main", "data:db"]) {
      const c = card(id);
      expect(await text(c.getByTestId("plan-feasible"))).toContain("yes");
      expect(await text(c)).toContain("Permission checks");
    }
    expect(await text(card("data:db").locator("table"))).toMatch(/ok/u);
    expect(
      (await text(page.getByTestId("plan-strategy"))).trim().length,
    ).toBeGreaterThan(0);
    await page.getByRole("heading", { name: "Known omissions" }).waitFor();
    await page.getByRole("heading", { name: "Plan job" }).waitFor();
    await eventually(
      () => text(page.getByTestId("stream-status")),
      120_000,
    ).toContain("ended");
    expect(await text(page.locator("main"))).toMatch(/Estimated size/u);

    // Cross-check the plan against the API, then reload the deep link.
    const planId = page.url().split("/").pop() ?? "";
    const plan = await api<any>(
      `/projects/${project}/builds/${buildId}/plans/${planId}`,
    );
    expect(plan.components.find((c: any) => c.id === "data:db").feasible).toBe(
      true,
    );
    await page.reload();
    await eventually(() => components.count()).toBe(5);
    await expectNoSecrets();
  });

  it("captures from the plan and shows the status, consistency, manifest, coverage and files", async () => {
    await page.getByRole("button", { name: "Capture from this plan" }).click();
    await page.waitForURL(/\/captures\/[0-9a-f-]{36}$/u);
    captureUrl = page.url();
    captureId = captureUrl.split("/").pop() ?? "";
    await eventually(
      () => text(page.getByTestId("capture-status")),
      JOB_TIMEOUT,
    ).toMatch(/completed|failed|cancelled/u);
    expect(
      (await text(page.getByTestId("capture-status"))).trim(),
      await page.locator("main").innerText(),
    ).toBe("completed");

    const capture = await api<any>(
      `/projects/${project}/builds/${buildId}/captures/${captureId}`,
    );
    expect(capture.component_statuses["source:main"]).toBe("captured");
    expect(capture.component_statuses["data:db"]).toBe("captured");

    // Consistency is worded as the classification says, never upgraded.
    const wording = {
      single_point: "single point",
      inconsistent: "inconsistent",
      unknown: "unknown",
    } as const;
    expect(await text(page.getByTestId("capture-consistency"))).toContain(
      wording[capture.consistency as keyof typeof wording],
    );
    const statuses = page.getByTestId("component-statuses");
    for (const id of ["source:main", "data:db"]) {
      const row = statuses.getByRole("row").filter({
        has: page.getByRole("rowheader", { name: id, exact: true }),
      });
      expect(await text(row)).toContain("captured");
    }

    // The manifest, parsed from /manifest: secrets are shown as names only.
    const manifestView = page.getByTestId("manifest");
    await manifestView.waitFor();
    const secrets = page.getByTestId("manifest-secrets");
    expect(await text(secrets)).toContain("names only");
    expect(await text(secrets)).toContain(DB_ENV_NAME);
    const components = page.getByTestId("manifest-component");
    const sourceCard = components.filter({ hasText: "source:main" });
    const dataCard = components.filter({ hasText: "data:db" });
    expect(await text(sourceCard)).toContain("captured");
    expect(await text(sourceCard)).toContain("git bundle");
    expect(await text(dataCard)).toContain("pg_dump");
    for (const label of [
      "Captured window",
      "Entries",
      "Bytes",
      "Limitations",
      "Omissions",
    ])
      expect(await text(dataCard)).toContain(label);
    for (const heading of [
      "Dependencies",
      "Manual prerequisites",
      "Missing or blocked",
      "Restore guards",
    ])
      await manifestView
        .getByRole("heading", { name: heading, exact: true })
        .waitFor();
    expect(await text(manifestView)).toContain("redis:7 (not pinned)");
    await page.getByTestId("coverage").waitFor();

    // Files: path, size and sha256 from the manifest, drawn lazily.
    const manifest = await api<any>(
      `/projects/${project}/builds/${buildId}/captures/${captureId}/manifest`,
    );
    await eventually(() => text(page.getByTestId("file-count"))).toContain(
      `${manifest.files.length} file`,
    );
    const rows = page.getByTestId("file-table-row");
    expect(await rows.count()).toBeGreaterThan(0);
    expect(await rows.count()).toBeLessThanOrEqual(
      Math.min(manifest.files.length, 60),
    );
    await page.getByLabel("Filter by path").fill("dump.pgc");
    await eventually(() => rows.count()).toBe(1);
    const dump = manifest.files.find((f: any) => f.path.endsWith("dump.pgc"));
    expect(await text(rows.first())).toContain(dump.sha256);
    await page.getByLabel("Filter by path").fill("");

    // No percentage is ever shown for a status.
    for (const id of [
      "capture-status",
      "capture-consistency",
      "component-statuses",
    ])
      expect(await text(page.getByTestId(id))).not.toMatch(/%/u);

    // Neither the fixture secret nor the database password reached the page.
    await expectNoSecrets();
    expect(JSON.stringify(manifest)).not.toContain(fx.databasePassword);
  });

  it("verifies all four scopes by restoring the capture, with the network verdict", async () => {
    await page.getByRole("link", { name: "Verify this capture" }).click();
    await page.getByRole("heading", { name: "Verify a capture" }).waitFor();
    const note = await text(page.getByRole("note"));
    expect(note).toContain("data_restore");
    expect(note).toContain("restore-only database");
    expect(note).toContain("blocked");
    for (const scope of [
      "integrity",
      "clean build",
      "data restore",
      "behavior",
    ])
      expect(
        await page
          .getByRole("checkbox", { name: scope, exact: true })
          .isChecked(),
      ).toBe(true);
    await page.getByRole("button", { name: "Start verification" }).click();
    await page.waitForURL(/\/verifications\/[0-9a-f-]{36}$/u);

    const overall = page.getByTestId("verification-overall");
    await eventually(() => text(overall), JOB_TIMEOUT).toContain(
      "behavior verified",
    );
    const expected: Record<string, string> = {
      integrity: "integrity verified",
      clean_build: "clean build verified",
      data_restore: "data restore verified",
      behavior: "behavior verified",
    };
    for (const [scope, status] of Object.entries(expected))
      expect(
        (await text(page.getByTestId(`scope-status-${scope}`))).trim(),
      ).toBe(status);
    // A registry step was needed, so the package is not network-free.
    const network = page.getByTestId("verification-network");
    expect((await text(network)).trim()).toMatch(/^yes/u);

    const verificationId = page.url().split("/").pop() ?? "";
    const verification = await api<any>(
      `/projects/${project}/builds/${buildId}/captures/${captureId}/verifications/${verificationId}`,
    );
    expect(verification.overall).toBe("behavior_verified");
    expect(verification.network_required.verdict).toBe("yes");
    for (const reason of verification.network_required.reasons)
      expect(await text(network)).toContain(reason);

    // The report is uploaded as verification evidence; the API has no route to download it.
    await page.getByTestId("report-note").waitFor();
    expect(await text(page.getByTestId("report-note"))).toContain(
      "does not expose a download route",
    );
    expect(await page.locator("main a[href*='evidence']").count()).toBe(0);
    expect(await text(page.getByTestId("verification-result"))).not.toMatch(
      /%/u,
    );
    await eventually(
      () => text(page.getByTestId("stream-status")),
      120_000,
    ).toContain("ended");
    await expectNoSecrets();

    // The capture page lists the verification for a reload-safe return.
    await gotoCapture();
    await page
      .getByTestId("list-verifications")
      .getByRole("link")
      .first()
      .waitFor();
  });

  it("exports a plain tar, downloads it, and the digest equals the API's record", async () => {
    await gotoCapture();
    await page.getByRole("link", { name: "Export this capture" }).click();
    await page.getByRole("heading", { name: "Export a capture" }).waitFor();
    expect(
      await page.getByRole("radio", { name: "Plain tar" }).isChecked(),
    ).toBe(true);
    await page.getByRole("button", { name: "Start export" }).click();
    await page.waitForURL(/\/exports\/[0-9a-f-]{36}$/u);
    const exportId = page.url().split("/").pop() ?? "";

    const link = page.getByTestId("export-download");
    await link.waitFor({ timeout: JOB_TIMEOUT });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      link.click(),
    ]);
    const bytes = await readFile(await download.path());
    const digest = sha256(bytes);

    const record = await api<any>(
      `/projects/${project}/builds/${buildId}/exports/${exportId}`,
    );
    expect(record.status).toBe("completed");
    expect(digest).toBe(record.sha256);
    expect(bytes.length).toBe(record.size);
    expect((await text(page.getByTestId("export-sha256"))).trim()).toBe(digest);
    expect(await text(page.getByTestId("export-size"))).toContain(
      `${bytes.length} bytes`,
    );
    expect(await text(page.getByTestId("export-encryption"))).toContain(
      "Not encrypted",
    );

    // The restore panel is built from the export and the manifest: argument names only.
    const panel = page.getByTestId("restore-panel");
    await panel.waitFor();
    const unpack = await text(page.getByTestId("cmd-unpack"));
    const restore = await text(page.getByTestId("cmd-restore"));
    expect(unpack).toBe("rea-recover unpack <export-file> --out <empty-dir>");
    expect(restore).toContain("rea-recover restore <unpacked-package-dir>");
    expect(restore).toContain("--database-url-env RESTORE_DATABASE_URL");
    expect(restore).toContain("--scope");
    expect(await text(panel)).not.toMatch(/:\/\/|postgres/u);
    expect(await text(panel)).not.toContain(DB_ENV_NAME);

    // The archive opens with the restore tooling and passes its integrity check.
    const tar = join(scratch, "ui-export.tar");
    await writeFile(tar, bytes);
    const root = (await unpackExport(tar, join(scratch, "ui-unpacked"))).root;
    expect((await verifyIntegrity(root)).ok).toBe(true);
    await expectNoSecrets();
  });

  it("exports encrypted to a key on the runner and shows the encryption with the key outside", async () => {
    await gotoCapture();
    await page.getByRole("link", { name: "Export this capture" }).click();
    await page
      .getByRole("radio", { name: "Encrypted to recipient keys" })
      .check();
    const help = await text(page.getByRole("note"));
    expect(help).toContain("must already be on the runner");
    expect(help).toContain("fails");
    await page.getByLabel("Recipient key ids").fill(recoveryKey.keyId);
    await page.getByRole("button", { name: "Start export" }).click();
    await page.waitForURL(/\/exports\/[0-9a-f-]{36}$/u);
    const exportId = page.url().split("/").pop() ?? "";

    const encryption = page.getByTestId("export-encryption");
    await eventually(() => text(encryption), JOB_TIMEOUT).toContain(
      "aes-256-gcm-envelope",
    );
    const shown = await text(encryption);
    expect(shown).toContain(recoveryKey.keyId);
    expect(shown).toContain("external");

    const link = page.getByTestId("export-download");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      link.click(),
    ]);
    const bytes = await readFile(await download.path());
    const record = await api<any>(
      `/projects/${project}/builds/${buildId}/exports/${exportId}`,
    );
    expect(record.encryption).toMatchObject({
      scheme: "aes-256-gcm-envelope",
      recipients: [recoveryKey.keyId],
      key_location: "external",
    });
    expect(sha256(bytes)).toBe(record.sha256);
    // Ciphertext: no key material, no manifest in the clear.
    expect(bytes.includes(Buffer.from(recoveryKey.keyBase64))).toBe(false);
    expect(bytes.includes(Buffer.from("manifest.json"))).toBe(false);
    expect(await text(page.getByTestId("cmd-unpack"))).toContain(
      "--key-file <key-file>",
    );
    await expectNoSecrets();
  });

  it("shows why an export to a key the runner does not hold failed", async () => {
    await gotoCapture();
    await page.getByRole("link", { name: "Export this capture" }).click();
    await page
      .getByRole("radio", { name: "Encrypted to recipient keys" })
      .check();
    await page.getByLabel("Recipient key ids").fill("not-a-key-on-this-runner");
    await page.getByRole("button", { name: "Start export" }).click();
    await page.waitForURL(/\/exports\/[0-9a-f-]{36}$/u);
    await eventually(
      () => text(page.getByTestId("export-status")),
      JOB_TIMEOUT,
    ).toContain("failed");
    const failure = page
      .getByRole("alert")
      .filter({ hasText: "not on this runner" });
    await failure.waitFor();
    expect(await page.getByTestId("export-download").count()).toBe(0);
  });

  it("returns to the build, lists its plan, capture and exports, and ran without script or CSP errors", async () => {
    await page.goto(`${stack.apiUrl}/preserve/builds/${buildId}`);
    await page.getByTestId("build-name").waitFor();
    await eventually(() =>
      page.getByTestId("list-plans").getByRole("link").count(),
    ).toBe(1);
    await eventually(() =>
      page.getByTestId("list-captures").getByRole("link").count(),
    ).toBe(1);
    await eventually(() =>
      page.getByTestId("list-exports").getByRole("link").count(),
    ).toBe(3);
    await page
      .getByLabel("Primary")
      .getByRole("link", { name: "Preserve" })
      .click();
    await page
      .getByTestId("build-row")
      .filter({ hasText: "Fixture Build" })
      .waitFor();
    // Every link the UI produced is relative to this origin.
    const hrefs = await page
      .locator("main a[href]")
      .evaluateAll((links) =>
        links.map((link) => link.getAttribute("href") ?? ""),
      );
    expect(hrefs.filter((href) => /^[a-z]+:|^\/\//iu.test(href))).toEqual([]);
    await expectNoSecrets();
    expect(pageErrors).toEqual([]);
    expect(cspViolations).toEqual([]);
    expect(stack.logs).not.toContain(fx.secretMarker);
    expect(stack.logs).not.toContain(fx.databasePassword);
  });
});
