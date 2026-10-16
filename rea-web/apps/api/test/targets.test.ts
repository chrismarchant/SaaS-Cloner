import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, expect, it } from "vitest";
import { digestCapabilities } from "@rea-web/contracts";
import {
  type Account,
  type Harness,
  createHarness,
  createRunner,
  describeDb,
  registerRunner,
  reportFor,
  uploadBytes,
} from "./helpers/harness.js";

const sha = (buffer: Buffer): string =>
  createHash("sha256").update(buffer).digest("hex");

describeDb("target uploads", () => {
  let h: Harness;
  let owner: Account;
  let p: string;
  beforeAll(async () => {
    h = await createHarness({ maxUploadBytes: 1024 * 1024 + 512 });
    owner = await h.register("uploader@example.com");
    p = owner.defaultProjectId as string;
  });
  afterAll(async () => {
    await h.close();
  });

  it("streams a 1 MiB payload to storage with its sha256, size and sniffed class", async () => {
    const payload = Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]),
      randomBytes(1024 * 1024 - 8),
    ]);
    const response = await uploadBytes(h, owner, p, "payload.so", payload);
    expect(response.status).toBe(201);
    expect(response.json).toMatchObject({
      kind: "upload",
      name: "payload.so",
      class: "elf",
      sha256: sha(payload),
      size: payload.length,
      project_id: p,
    });
    expect(response.raw).not.toContain("object_key");
    const stored = await h.store.head(
      `projects/${p}/targets/${response.json.id}/payload`,
    );
    expect(stored?.size).toBe(payload.length);
    expect(stored?.sha256).toBe(sha(payload));

    const fetched = await h.api(
      "GET",
      `/api/v1/projects/${p}/targets/${response.json.id}`,
      {
        auth: owner.auth,
      },
    );
    expect(fetched.json.sha256).toBe(sha(payload));
    const list = await h.api("GET", `/api/v1/projects/${p}/targets`, {
      auth: owner.auth,
    });
    expect(list.json.items.map((t: { id: string }) => t.id)).toContain(
      response.json.id,
    );
  });

  it("classifies by magic number and extension", async () => {
    const zip = await uploadBytes(
      h,
      owner,
      p,
      "bundle.zip",
      Buffer.from([0x50, 0x4b, 3, 4, 0, 0]),
    );
    expect(zip.json.class).toBe("zip_archive");
    const apk = await uploadBytes(
      h,
      owner,
      p,
      "app.apk",
      Buffer.from([0x50, 0x4b, 3, 4, 0, 0]),
    );
    expect(apk.json.class).toBe("apk");
    const har = await uploadBytes(
      h,
      owner,
      p,
      "session.har",
      Buffer.from('{"log":{"version":"1.2"}}'),
    );
    expect(har.json.class).toBe("har");
    const capture = await h.api(
      "POST",
      `/api/v1/projects/${p}/targets/runtime-captures`,
      {
        auth: owner.auth,
        payload: Buffer.from('{"log":{"version":"1.2"}}'),
        headers: {
          "content-type": "application/json",
          "x-target-name": "cap.har",
        },
      },
    );
    expect(capture.status).toBe(201);
    expect(capture.json).toMatchObject({
      kind: "runtime_capture",
      class: "har",
    });
  });

  it("accepts a zero-byte upload", async () => {
    const response = await uploadBytes(
      h,
      owner,
      p,
      "empty.bin",
      Buffer.alloc(0),
    );
    expect(response.status).toBe(201);
    expect(response.json.size).toBe(0);
    expect(response.json.sha256).toBe(sha(Buffer.alloc(0)));
  });

  it("rejects an oversize body by declared length, leaving no object", async () => {
    const before = await h.store.list("");
    const response = await uploadBytes(
      h,
      owner,
      p,
      "big.bin",
      Buffer.alloc(1024 * 1024 + 600),
    );
    expect(response.status).toBe(413);
    expect(response.json.error.code).toBe("payload_too_large");
    const after = await h.store.list("");
    expect(after.keys.length).toBe(before.keys.length);
  });

  it("rejects an oversize chunked body mid-stream and removes the partial object", async () => {
    const before = (await h.store.list("")).keys.length;
    const chunks = Array.from({ length: 12 }, () =>
      Buffer.alloc(128 * 1024, 7),
    );
    const response = await h.app.inject({
      method: "POST",
      url: `/api/v1/projects/${p}/targets/uploads`,
      headers: {
        cookie: owner.cookie,
        "content-type": "application/octet-stream",
        "x-target-name": "chunked.bin",
      },
      payload: Readable.from(chunks),
    });
    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body).error.code).toBe("payload_too_large");
    expect((await h.store.list("")).keys.length).toBe(before);
    const targets = await h.api("GET", `/api/v1/projects/${p}/targets`, {
      auth: owner.auth,
    });
    expect(
      targets.json.items.some(
        (t: { name: string }) => t.name === "chunked.bin",
      ),
    ).toBe(false);
  });

  it("rejects bad X-Target-Name values before reading the body", async () => {
    const bad = [
      "",
      "..",
      ".",
      "a/b.bin",
      "a\\b.bin",
      "x".repeat(256),
      " leading.bin",
      "tab\there",
    ];
    for (const name of bad) {
      const response = await uploadBytes(h, owner, p, name, Buffer.from("x"));
      expect(response.status, JSON.stringify(name)).toBe(400);
      expect(response.json.error.code).toBe("validation_failed");
    }
    const missing = await h.api(
      "POST",
      `/api/v1/projects/${p}/targets/uploads`,
      {
        auth: owner.auth,
        payload: Buffer.from("x"),
        headers: { "content-type": "application/octet-stream" },
      },
    );
    expect(missing.status).toBe(400);
    const ok = await uploadBytes(
      h,
      owner,
      p,
      "x".repeat(255),
      Buffer.from("x"),
    );
    expect(ok.status).toBe(201);
  });

  it("accepts multipart/form-data uploads and enforces the same cap", async () => {
    const boundary = "----reaweb";
    const file = Buffer.from("hello multipart");
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="form.txt"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await h.api(
      "POST",
      `/api/v1/projects/${p}/targets/uploads`,
      {
        auth: owner.auth,
        payload: body,
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
      },
    );
    expect(response.status).toBe(201);
    expect(response.json).toMatchObject({
      name: "form.txt",
      size: file.length,
      sha256: sha(file),
    });
  });

  it("deletes a target and its object, refusing while an investigation references it", async () => {
    const upload = await uploadBytes(
      h,
      owner,
      p,
      "deleteme.bin",
      Buffer.from("zzz"),
    );
    const key = `projects/${p}/targets/${upload.json.id}/payload`;
    expect(await h.store.head(key)).not.toBeNull();
    const referenced = await uploadBytes(
      h,
      owner,
      p,
      "kept.bin",
      Buffer.from("kkk"),
    );
    const investigation = await h.api(
      "POST",
      `/api/v1/projects/${p}/investigations`,
      {
        auth: owner.auth,
        body: { target_id: referenced.json.id, question: "q" },
      },
    );
    expect(investigation.status).toBe(201);
    const blocked = await h.api(
      "DELETE",
      `/api/v1/projects/${p}/targets/${referenced.json.id}`,
      {
        auth: owner.auth,
      },
    );
    expect(blocked.status).toBe(409);
    expect(
      await h.store.head(`projects/${p}/targets/${referenced.json.id}/payload`),
    ).not.toBeNull();
    const removed = await h.api(
      "DELETE",
      `/api/v1/projects/${p}/targets/${upload.json.id}`,
      {
        auth: owner.auth,
      },
    );
    expect(removed.status).toBe(200);
    expect(await h.store.head(key)).toBeNull();
    const gone = await h.api(
      "GET",
      `/api/v1/projects/${p}/targets/${upload.json.id}`,
      {
        auth: owner.auth,
      },
    );
    expect(gone.status).toBe(404);
  });
});

describeDb("URL targets", () => {
  let h: Harness;
  let owner: Account;
  let p: string;
  beforeAll(async () => {
    h = await createHarness();
    owner = await h.register("urls@example.com");
    p = owner.defaultProjectId as string;
  });
  afterAll(async () => {
    await h.close();
  });
  const register = (url: string) =>
    h.api("POST", `/api/v1/projects/${p}/targets/urls`, {
      auth: owner.auth,
      body: { url },
    });

  it("registers a public https URL as a website_url target", async () => {
    const response = await register("https://app.example.com/dashboard?x=1");
    expect(response.status).toBe(201);
    expect(response.json).toMatchObject({
      kind: "url",
      class: "website_url",
      url: "https://app.example.com/dashboard?x=1",
      sha256: null,
      size: null,
    });
  });

  it.each([
    ["loopback", "http://127.0.0.1/admin"],
    ["metadata", "http://169.254.169.254/latest/meta-data/"],
    ["localhost", "http://localhost:8080/"],
    ["subdomain of localhost", "http://api.localhost/"],
    ["ftp", "ftp://example.com/file"],
    ["file", "file:///etc/passwd"],
    ["private", "http://10.0.0.5/"],
    ["ipv6 loopback", "http://[::1]/"],
    ["credentials", "https://user:pass@example.com/"],
    ["single-label host", "http://intranet/"],
  ])(
    "rejects %s with unsafe_url and the rejection reason",
    async (_label, url) => {
      const response = await register(url);
      expect(response.status).toBe(400);
      expect(response.json.error.code).toBe("unsafe_url");
      expect(typeof response.json.error.details.rejection.kind).toBe("string");
    },
  );

  it("rejects a malformed URL as a validation error", async () => {
    const response = await register("not a url");
    expect(response.status).toBe(400);
  });

  it("refuses to start an investigation on a URL target that no longer validates", async () => {
    const target = await h.repos.targets.create({
      project_id: p,
      kind: "url",
      name: "tampered",
      class: "website_url",
      url: "http://127.0.0.1/",
      created_by: owner.userId,
    });
    const response = await h.api(
      "POST",
      `/api/v1/projects/${p}/investigations`,
      {
        auth: owner.auth,
        body: { target_id: target.id, question: "q" },
      },
    );
    expect(response.status).toBe(400);
    expect(response.json.error.code).toBe("unsafe_url");
  });
});

describeDb("routing", () => {
  let h: Harness;
  let owner: Account;
  let p: string;
  beforeAll(async () => {
    h = await createHarness();
    owner = await h.register("routing@example.com");
    p = owner.defaultProjectId as string;
  });
  afterAll(async () => {
    await h.close();
  });

  it("lists unmet requirements from a registered runner report, verbatim from the runner", async () => {
    const runner = await createRunner(h, owner, p, "linux-fixture-runner");
    const before = await uploadBytes(
      h,
      owner,
      p,
      "app.apk",
      Buffer.from([0x50, 0x4b, 3, 4]),
    );
    const noReport = await h.api(
      "GET",
      `/api/v1/projects/${p}/targets/${before.json.id}/routing`,
      { auth: owner.auth },
    );
    expect(noReport.status).toBe(200);
    expect(noReport.json.candidate_runners[0]).toMatchObject({
      runner_id: runner.id,
      satisfied: false,
    });
    expect(noReport.json.candidate_runners[0].unmet[0].reason).toBe(
      "never_connected",
    );

    await registerRunner(h, runner, reportFor("linux-fixture-runner"));

    const apk = await h.api(
      "GET",
      `/api/v1/projects/${p}/targets/${before.json.id}/routing`,
      {
        auth: owner.auth,
      },
    );
    expect(apk.json).toMatchObject({
      class: "apk",
      first_tool: "inspect_android_package",
      required_providers_any_of: ["jadx"],
    });
    const candidate = apk.json.candidate_runners[0];
    expect(candidate.satisfied).toBe(false);
    const tool = candidate.unmet.find(
      (u: { kind: string }) => u.kind === "tool",
    );
    expect(tool).toMatchObject({
      value: "inspect_android_package",
      reason: "provider_missing",
    });
    expect(tool.remediation).toContain("REA_JADX_MCP_JAR");
    const provider = candidate.unmet.find(
      (u: { kind: string }) => u.kind === "provider",
    );
    expect(provider).toMatchObject({
      value: "jadx",
      reason: "provider_unavailable",
    });

    const asar = await uploadBytes(h, owner, p, "app.asar", Buffer.from("x"));
    const satisfied = await h.api(
      "GET",
      `/api/v1/projects/${p}/targets/${asar.json.id}/routing`,
      { auth: owner.auth },
    );
    expect(satisfied.json.class).toBe("asar");
    expect(satisfied.json.candidate_runners[0]).toMatchObject({
      satisfied: true,
      unmet: [],
    });

    const dmg = await uploadBytes(h, owner, p, "disk.dmg", Buffer.from("x"));
    const wrongOs = await h.api(
      "GET",
      `/api/v1/projects/${p}/targets/${dmg.json.id}/routing`,
      {
        auth: owner.auth,
      },
    );
    expect(
      wrongOs.json.candidate_runners[0].unmet.some(
        (u: { kind: string }) => u.kind === "os",
      ),
    ).toBe(true);
  });

  it("treats any listed provider as sufficient", async () => {
    const runner = await createRunner(h, owner, p, "with-jadx");
    await registerRunner(
      h,
      runner,
      reportFor("with-jadx", (report) => {
        report.analysis_provider_candidates.push({
          provider_id: "jadx",
          availability: { status: "available" },
        });
        const group = report.tool_availability.groups.find((g) =>
          g.names.includes("inspect_android_package"),
        );
        if (group) {
          group.available = true;
          group.reason = null;
          group.remediation = null;
        }
      }),
    );
    const apk = await uploadBytes(
      h,
      owner,
      p,
      "second.apk",
      Buffer.from([0x50, 0x4b, 3, 4]),
    );
    const routing = await h.api(
      "GET",
      `/api/v1/projects/${p}/targets/${apk.json.id}/routing`,
      {
        auth: owner.auth,
      },
    );
    const entry = routing.json.candidate_runners.find(
      (c: { runner_id: string }) => c.runner_id === runner.id,
    );
    expect(entry).toMatchObject({ satisfied: true, unmet: [] });
  });

  it("serves runner summaries, the verbatim report and the advertised tool union", async () => {
    const expected = digestCapabilities(reportFor("expected"));
    const runners = await h.api("GET", `/api/v1/projects/${p}/runners`, {
      auth: owner.auth,
    });
    const fixture = runners.json.items.find(
      (r: { name: string }) => r.name === "linux-fixture-runner",
    );
    expect(fixture).toMatchObject({
      status: "online",
      tools_available_count: expected.tools_available.length,
      tools_target_required_count: expected.tools_target_required.length,
      tools_unavailable_count: expected.tools_unavailable.size,
    });
    expect(fixture.providers_available).toContain("rea-dotnet-static");
    expect(fixture.host.os).toBe("linux");
    const capabilities = await h.api(
      "GET",
      `/api/v1/projects/${p}/runners/${fixture.id}/capabilities`,
      { auth: owner.auth },
    );
    expect(capabilities.json.report.tools_list.length).toBe(
      reportFor("n").tools_list.length,
    );
    expect(capabilities.json.report.rea.package_version).toBe("6.4.0");
    const tools = await h.api("GET", `/api/v1/projects/${p}/tools`, {
      auth: owner.auth,
    });
    const inspect = tools.json.items.find(
      (t: { name: string }) => t.name === "inspect_android_package",
    );
    expect(inspect.per_runner).toHaveLength(2);
    const unavailable = inspect.per_runner.find(
      (r: { runner_name: string }) => r.runner_name === "linux-fixture-runner",
    );
    expect(unavailable).toMatchObject({
      available: false,
      reason: "provider_missing",
    });
    expect(unavailable.remediation).toContain("REA_JADX_MCP_JAR");
    const available = inspect.per_runner.find(
      (r: { runner_name: string }) => r.runner_name === "with-jadx",
    );
    expect(available).toMatchObject({ available: true, reason: null });
    expect(
      new Set(tools.json.items.map((t: { name: string }) => t.name)).size,
    ).toBe(tools.json.items.length);
  });
});
