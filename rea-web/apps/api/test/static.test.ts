import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type Harness, createHarness, describeDb } from "./helpers/harness.js";

describeDb("serving the web UI", () => {
  let h: Harness;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "rea-web-static-"));
    await writeFile(
      join(dir, "index.html"),
      "<!doctype html><title>REA Web</title>",
    );
    await writeFile(join(dir, "app.js"), "export {};");
    h = await createHarness({ staticDir: dir });
  });
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves assets and the SPA for deep links while API misses stay JSON 404s", async () => {
    expect((await h.api("GET", "/app.js")).raw).toBe("export {};");
    const deep = await h.api("GET", "/projects/x/investigations/y");
    expect(deep.status).toBe(200);
    expect(deep.raw).toContain("<title>REA Web</title>");
    const apiMiss = await h.api("GET", "/api/v1/no-such-route");
    expect(apiMiss.status).toBe(404);
    expect(apiMiss.json.error.code).toBe("not_found");
    const postMiss = await h.api("POST", "/somewhere", { body: {} });
    expect(postMiss.status).toBe(404);
    expect(postMiss.json.error.code).toBe("not_found");
    expect((await h.api("GET", "/api/v1/health")).json.status).toBe("ok");
  });
});
