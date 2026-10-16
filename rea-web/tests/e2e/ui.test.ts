/**
 * The Investigate workflow driven through the built web UI in a real browser.
 * The UI is served from the API origin (`REA_WEB_STATIC_DIR`), talks to the
 * built API, and a real runner (separate process) analyses the fixture with
 * the built upstream REA server. Nothing is simulated; every step below is a
 * click or keystroke, and the API is consulted only to cross-check what the
 * page shows.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { REA_WEB_ROOT, Stack, stackUnavailableReason } from "./stack.js";

const CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const WEB_DIST = join(REA_WEB_ROOT, "apps/web/dist");
const FIXTURE = join(REA_WEB_ROOT, "fixtures/investigation/js-cli-app");

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

describeUi("investigate workflow through the web UI", () => {
  const stack = new Stack();
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let scratch = "";
  let zipPath = "";
  let zip: Buffer;
  let runnerToken = "";
  let investigationUrl = "";
  let approvedUrl = "";
  let approvals = 0;
  let project = "";
  let analysisEvidenceId = "";
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

  /** Fills the New investigation form (static-only, model follow-up off). */
  const createInvestigation = async (
    question: string,
    approvalEffects: readonly string[] = [],
  ): Promise<string> => {
    await page
      .getByLabel("Primary")
      .getByRole("link", { name: "Investigations" })
      .click();
    await page.getByRole("link", { name: "New investigation" }).click();
    await page.getByLabel("Question").fill(question);
    expect(
      await page.getByRole("radio", { name: "Static only" }).isChecked(),
    ).toBe(true);
    const approval = page.getByRole("group", {
      name: "Effects that require approval",
    });
    expect(
      await approval
        .getByRole("checkbox", { name: /executesForeignCode/u })
        .isChecked(),
    ).toBe(true);
    for (const effect of approvalEffects)
      await approval
        .getByRole("checkbox", { name: new RegExp(effect, "u") })
        .check();
    await page.getByLabel(/Model follow-up/u).uncheck();
    await page.getByRole("button", { name: "Create investigation" }).click();
    await page.waitForURL(/\/investigations\/[0-9a-f-]{36}/u);
    return page.url();
  };

  const investigationId = (url: string): string =>
    url.match(/investigations\/([0-9a-f-]{36})/u)?.[1] ?? "";

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "rea-web-ui-"));
    zipPath = join(scratch, "notes-cli.zip");
    execFileSync("python3", ["-I", "-m", "zipfile", "-c", zipPath, FIXTURE]);
    zip = await readFile(zipPath);
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
  });

  afterAll(async () => {
    await browser?.close();
    await stack.stop();
    await rm(scratch, { recursive: true, force: true });
  });

  it("registers the first user, who owns the default project", async () => {
    await page.goto(stack.apiUrl);
    await page.getByRole("button", { name: "Register" }).click();
    await page.getByLabel("Email").fill("ui-owner@example.test");
    await page.getByLabel("Password").fill("correct horse battery");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByRole("link", { name: "Runners" }).waitFor();
    expect(await text(page.getByTestId("project-name"))).not.toBe("");
    const projects = await api<{ items: { id: string }[] }>("/projects");
    project = projects.items[0]?.id ?? "";
    expect(project).not.toBe("");
  });

  it("creates a runner, shows its token once, and shows it online with its capabilities", async () => {
    await page.getByRole("link", { name: "Runners" }).click();
    await page.getByLabel("Runner name").fill("ui-runner");
    await page.getByRole("button", { name: "Create runner" }).click();

    const token = page.getByTestId("runner-token");
    await token.waitFor();
    runnerToken = await token.inputValue();
    expect(runnerToken.length).toBeGreaterThan(20);
    await page.getByText("shown only once").waitFor();
    await page.getByText("REA_WEB_RUNNER_TOKEN").first().waitFor();
    await page.getByText("REA_WEB_API_URL").first().waitFor();

    // Dismissing the notice removes the secret from the page for good.
    await page.getByRole("button", { name: "I have stored the token" }).click();
    expect(await page.content()).not.toContain(runnerToken);

    stack.startRunner(runnerToken);
    const row = page.getByTestId("runner-row").filter({ hasText: "ui-runner" });
    await row
      .getByText("online", { exact: true })
      .waitFor({ timeout: 120_000 });
    expect(await page.content()).not.toContain(runnerToken);

    await row.getByRole("link", { name: /Capabilities/u }).click();
    await page.getByRole("heading", { name: "Tool availability" }).waitFor();
    expect(await text(page.getByTestId("availability-table"))).toContain(
      "analyze_javascript_application",
    );
    expect(await text(page.locator("#host").locator(".."))).toContain("linux");
  });

  it("uploads a target with its digest, and shows its routing", async () => {
    await page.getByRole("link", { name: "Targets" }).click();
    await page.locator('input[type="file"]').setInputFiles(zipPath);
    await eventually(() => page.getByLabel("Target name").inputValue()).toBe(
      "notes-cli.zip",
    );
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    const digest = page.getByTestId("target-sha256");
    await digest.waitFor();
    expect(await text(digest)).toBe(sha256(zip));
    expect(await text(page.getByTestId("target-size"))).toContain(
      `${zip.length} bytes`,
    );

    const row = page
      .getByTestId("target-row")
      .filter({ hasText: "notes-cli.zip" });
    await row.getByRole("button", { name: /Show routing/u }).click();
    const firstTool = page.getByTestId("first-tool");
    await firstTool.waitFor();
    expect((await text(firstTool)).length).toBeGreaterThan(0);
    await page
      .getByTestId("routing")
      .getByRole("row", { name: /ui-runner/u })
      .waitFor();
  });

  it("rejects an unsafe URL target with the API's own details", async () => {
    await page
      .getByLabel("URL", { exact: true })
      .fill("http://127.0.0.1/admin");
    await page.getByRole("button", { name: "Add URL target" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "unsafe_url" });
    await alert.waitFor();
    expect(await text(alert)).toContain("HTTP 400");
  });

  it("creates a static-only investigation with model follow-up off", async () => {
    investigationUrl = await createInvestigation(
      "What does this CLI do and where does it store notes?",
    );
  });

  it("follows the job timeline live until it is terminal", async () => {
    const status = page.getByTestId("investigation-status");
    await eventually(() => text(status), 300_000).toMatch(
      /completed|failed|cancelled/u,
    );
    expect(
      (await text(status)).trim(),
      await page.locator("main").innerText(),
    ).toBe("completed");
    await eventually(() => text(page.getByTestId("stream-status"))).toContain(
      "ended",
    );
    const timeline = await page.locator(".timeline").innerText();
    expect(timeline).toContain("job.created");
    expect(timeline).toContain("job.tool_call");
    expect(await text(page.locator(".job-panel .badge").first())).toBe(
      "succeeded",
    );
  });

  it("lists tool calls and opens the raw result, derived summary and evidence explorer", async () => {
    await page.getByRole("link", { name: "Tool calls", exact: true }).click();
    const row = page
      .getByTestId("call-row")
      .filter({ hasText: "analyze_javascript_application" });
    await row.waitFor();
    analysisEvidenceId = await text(row.locator("td code").last());
    expect(analysisEvidenceId).toMatch(/^ev_[0-9a-f]{64}$/u);
    await row.getByRole("button", { name: /Inspect/u }).click();

    const detail = page.getByTestId("call-detail");
    await detail.getByRole("button", { name: "Derived summary" }).click();
    expect(await text(page.getByTestId("derived-summary"))).toContain(
      analysisEvidenceId,
    );

    await detail.getByRole("button", { name: "Raw result" }).click();
    const raw = page.getByTestId("raw-result");
    await raw.waitFor();
    const rawText = await text(raw);
    expect(rawText).toContain("structuredContent");
    expect(rawText).toContain("normalized_result");
    expect(rawText).toContain(analysisEvidenceId);

    await detail.getByRole("button", { name: "Evidence explorer" }).click();
    const explorer = page.getByTestId("evidence-explorer");
    await explorer.waitFor();
    // Nodes load lazily: opening one reveals its children.
    const open = explorer.locator('button.tree-toggle[aria-expanded="true"]');
    const closed = explorer.locator(
      'button.tree-toggle[aria-expanded="false"]',
    );
    const before = await open.count();
    expect(await closed.count()).toBeGreaterThan(0);
    await closed.first().click();
    expect(await open.count()).toBe(before + 1);
    expect(await text(explorer)).toContain("normalized_result");
  });

  it("groups findings by class and links citations to tool calls", async () => {
    await page.getByRole("link", { name: "Findings", exact: true }).click();
    const facts = page.getByTestId("findings-fact");
    await facts.waitFor();
    await facts.locator("article").first().waitFor();
    expect(await text(facts.getByRole("heading", { level: 3 }))).toMatch(
      /^fact \([1-9]/u,
    );
    for (const kind of ["inference", "proposal", "unknown"])
      await page.getByTestId(`findings-${kind}`).waitFor();
    await facts.locator("a.chip").first().click();
    await page.getByTestId("call-detail").waitFor();
    expect(page.url()).toContain("tab=calls&call=");
  });

  it("runs an inspect_analysis_view follow-up through the generated form and evidence picker", async () => {
    await page.getByRole("link", { name: "Follow-up", exact: true }).click();
    await page
      .getByLabel("Tool", { exact: true })
      .selectOption("inspect_analysis_view");
    await page
      .getByRole("table", { name: /Availability per runner/u })
      .waitFor();

    const source = page.getByRole("textbox", { name: /^source/u });
    const view = page.getByRole("textbox", { name: /^view/u });
    await page
      .getByLabel("Retained evidence for source")
      .selectOption(analysisEvidenceId);
    await page
      .getByRole("button", { name: "Insert evidence reference into source" })
      .click();
    expect(JSON.parse(await source.inputValue())).toEqual({
      kind: "retained-evidence",
      evidence_id: analysisEvidenceId,
    });
    await view.fill('{ "kind": "summary" }');

    // Raw JSON mode carries exactly what the form holds.
    await page.getByRole("button", { name: "Raw JSON arguments" }).click();
    expect(
      JSON.parse(await page.getByLabel("Arguments (JSON object)").inputValue()),
    ).toEqual({
      source: { kind: "retained-evidence", evidence_id: analysisEvidenceId },
      view: { kind: "summary" },
    });
    await page.getByRole("button", { name: "Form", exact: true }).click();
    expect(JSON.parse(await source.inputValue()).evidence_id).toBe(
      analysisEvidenceId,
    );

    await page.getByRole("button", { name: "Run follow-up" }).click();
    const outcome = page.getByTestId("follow-up-outcome");
    await outcome.waitFor({ timeout: 180_000 });
    expect((await text(outcome)).trim()).toBe("ran");

    await page.getByRole("link", { name: "Tool calls", exact: true }).click();
    await eventually(() =>
      page
        .getByTestId("call-row")
        .filter({ hasText: "inspect_analysis_view" })
        .count(),
    ).toBe(1);
  });

  it("pauses for approval, shows the request and resumes when approved", async () => {
    approvedUrl = await createInvestigation(
      "Second look: run again with every filesystem effect approved by hand",
      ["writesFilesystem", "launchesProcess", "mutatesSession"],
    );
    const approve = page.getByRole("button", { name: "Approve", exact: true });
    await approve.waitFor({ timeout: 120_000 });
    const section = page.getByRole("heading", { name: "Approval required" });
    expect(await text(section.locator(".."))).toMatch(/Effects/u);
    expect(await text(section.locator(".."))).toMatch(
      /writesFilesystem|launchesProcess|mutatesSession/u,
    );
    expect(await text(page.getByTestId("investigation-status"))).toContain(
      "running",
    );
    approvals = 0;
    // Approve every pause until the run finishes.
    await eventually(async () => {
      if ((await approve.count()) > 0) {
        await approve.first().click();
        approvals += 1;
        await approve
          .first()
          .waitFor({ state: "detached", timeout: 30_000 })
          .catch(() => undefined);
      }
      return text(page.getByTestId("investigation-status"));
    }, 300_000).toContain("completed");
    expect(approvals).toBeGreaterThan(0);
    const events = await page.locator(".timeline").innerText();
    expect(events).toContain("job.approval_requested");
    expect(events).toContain("job.approval_decided");
  });

  it("cancels the run when its approval request is rejected", async () => {
    await createInvestigation("Rejected run: refuse the first approval", [
      "writesFilesystem",
      "launchesProcess",
      "mutatesSession",
    ]);
    const reject = page.getByRole("button", { name: "Reject", exact: true });
    await reject.waitFor({ timeout: 120_000 });
    await reject.click();
    await eventually(
      () => text(page.getByTestId("investigation-status")),
      120_000,
    ).toContain("cancelled");
  });

  it("requests cancellation of a live job from the job panel", async () => {
    await createInvestigation("Cancelled run: stop it while it is live");
    const cancel = page.getByRole("button", { name: "Cancel job" });
    await cancel.waitFor();
    await cancel.click();
    // The API records the request; whether the runner stops in time or has
    // already finished is the runner's race, so only the request is asserted.
    await page.getByText("Cancel requested", { exact: true }).waitFor();
    const jobId = await text(page.locator(".job-panel code").first());
    const job = await api<{ cancel_requested_at: string | null }>(
      `/projects/${project}/jobs/${jobId}`,
    );
    expect(job.cancel_requested_at).not.toBeNull();
    await eventually(
      () => text(page.getByTestId("investigation-status")),
      120_000,
    ).toMatch(/cancelled|completed/u);
  });

  it("compares retained evidence across two investigations and links the anchor tool call", async () => {
    const first = investigationId(investigationUrl);
    const second = investigationId(approvedUrl);
    const evidenceOf = async (id: string, tool: string): Promise<string> => {
      const calls = await api<{ items: any[] }>(
        `/projects/${project}/investigations/${id}/tool-calls?limit=200`,
      );
      return calls.items.find(
        (call) => call.tool_name === tool && call.evidence_id,
      ).evidence_id;
    };
    await page
      .getByLabel("Primary")
      .getByRole("link", { name: "Compare" })
      .click();
    for (const [side, id] of [
      ["Left", first],
      ["Right", second],
    ] as const) {
      const group = page.getByRole("group", { name: side, exact: true });
      await group.getByLabel("Investigation").selectOption(id);
      await group
        .getByLabel("Evidence id")
        .selectOption(await evidenceOf(id, "inspect_artifact"));
    }
    await page.getByLabel("Comparison tool").selectOption("compare_artifacts");
    await page.getByRole("button", { name: "Run comparison" }).click();
    const outcome = page.getByTestId("compare-outcome");
    await outcome.waitFor({ timeout: 180_000 });
    expect((await text(outcome)).trim()).toBe("ran");
    const result = page.getByTestId("compare-result");
    expect(await text(result)).toContain(first);
    expect(await text(result)).toContain(second);
    await result.getByRole("link", { name: /anchor investigation/u }).click();
    await page.getByTestId("call-detail").waitFor();
    expect(page.url()).toContain(`/investigations/${first}?tab=calls&call=`);
    expect(await text(page.getByTestId("call-detail"))).toContain(
      "compare_artifacts",
    );
  });

  it("shows why a comparison is refused, with the producer's reasons", async () => {
    const first = investigationId(investigationUrl);
    const bundleOf = async (id: string): Promise<string> => {
      const evidence = await api<{ items: any[] }>(
        `/projects/${project}/investigations/${id}/evidence`,
      );
      return evidence.items.find(
        (item) =>
          item.kind === "bundle" && item.name.startsWith("evidence-bundle-"),
      ).id;
    };
    await page
      .getByLabel("Primary")
      .getByRole("link", { name: "Compare" })
      .click();
    for (const [side, id] of [
      ["Left", first],
      ["Right", investigationId(approvedUrl)],
    ] as const) {
      const group = page.getByRole("group", { name: side, exact: true });
      await group
        .getByRole("radio", { name: "Evidence bundle artifact" })
        .check();
      await group.getByLabel("Investigation").selectOption(id);
      await group
        .getByLabel("Evidence bundle", { exact: true })
        .selectOption(await bundleOf(id));
    }
    await page.getByLabel("Comparison tool").selectOption("compare_artifacts");
    await page.getByRole("button", { name: "Run comparison" }).click();
    const outcome = page.getByTestId("compare-outcome");
    await outcome.waitFor({ timeout: 180_000 });
    expect((await text(outcome)).trim()).toBe("invalid_arguments");
    expect(await text(page.getByTestId("compare-result"))).toContain(
      "compare_bundles",
    );

    // The bundle-level tool accepts the same references.
    await page.getByLabel("Comparison tool").selectOption("compare_bundles");
    await page.getByRole("button", { name: "Run comparison" }).click();
    await eventually(
      () => text(page.getByTestId("compare-outcome")),
      180_000,
    ).toContain("ran");
    expect(await text(page.getByTestId("compare-result"))).toContain(
      "Bundle SHA-256",
    );
  });

  it("exports the investigation and downloads a zip whose digest matches the API's record", async () => {
    await page.goto(investigationUrl);
    await page.getByRole("link", { name: "Export", exact: true }).click();
    await page.getByRole("button", { name: "Export investigation" }).click();
    const link = page.getByTestId("export-download");
    await link.waitFor({ timeout: 180_000 });

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      link.click(),
    ]);
    const bytes = await readFile(await download.path());
    const digest = sha256(bytes);

    const jobs = await api<{ items: any[] }>(
      `/projects/${project}/jobs?kind=investigation.export`,
    );
    const job = jobs.items.find(
      (candidate) =>
        candidate.state === "succeeded" && candidate.result?.sha256,
    );
    expect(job, JSON.stringify(jobs.items)).toBeDefined();
    expect(digest).toBe(job.result.sha256);
    expect(bytes.length).toBe(job.result.size);
    expect(await text(page.getByTestId("export-sha256"))).toBe(digest);
    expect(await text(page.getByTestId("export-members"))).toBe(
      String(job.result.members),
    );
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(await text(page.getByTestId("export-result"))).toContain(
      "Redacted members",
    );
  });

  it("reloads the investigation URL and ran without script or CSP errors", async () => {
    await page.goto(investigationUrl);
    await eventually(() =>
      text(page.getByTestId("investigation-status")),
    ).toContain("completed");
    expect(pageErrors).toEqual([]);
    expect(cspViolations).toEqual([]);
  });

  it("logs out and returns to the sign-in form", async () => {
    await page.getByRole("button", { name: "Log out" }).click();
    await page.getByLabel("Email").waitFor();
    await page
      .getByRole("button", { name: "Log in", exact: true })
      .first()
      .waitFor();
  });
});
