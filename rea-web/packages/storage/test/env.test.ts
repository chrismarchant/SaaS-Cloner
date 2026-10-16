import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createObjectStoreFromEnv } from "../src/index.js";

const SECRET = "super-secret-value-do-not-echo";
const s3Env = {
  REA_WEB_STORAGE_BACKEND: "s3",
  REA_WEB_S3_ENDPOINT: "http://127.0.0.1:1",
  REA_WEB_S3_REGION: "us-east-1",
  REA_WEB_S3_BUCKET: "bucket-name-value",
  REA_WEB_S3_ACCESS_KEY_ID: "access-key-value",
  REA_WEB_S3_SECRET_ACCESS_KEY: SECRET,
  REA_WEB_S3_FORCE_PATH_STYLE: "true",
};

describe("createObjectStoreFromEnv", () => {
  it("builds an fs store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rea-storage-env-"));
    try {
      const store = createObjectStoreFromEnv({
        REA_WEB_STORAGE_BACKEND: "fs",
        REA_WEB_STORAGE_FS_ROOT: join(dir, "objects"),
      });
      expect(store.backend).toBe("fs");
      await store.put("a/b", "x");
      expect((await store.head("a/b"))?.size).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds an s3 store without touching the network", () => {
    const store = createObjectStoreFromEnv(s3Env);
    expect(store.backend).toBe("s3");
    expect(typeof store.presignGet).toBe("function");
  });

  it("accepts an s3 config without endpoint, path-style flag or prefix", () => {
    const {
      REA_WEB_S3_ENDPOINT: _endpoint,
      REA_WEB_S3_FORCE_PATH_STYLE: _style,
      ...minimal
    } = s3Env;
    expect(createObjectStoreFromEnv(minimal).backend).toBe("s3");
  });

  it.each([
    ["REA_WEB_STORAGE_BACKEND", s3Env],
    ["REA_WEB_S3_REGION", s3Env],
    ["REA_WEB_S3_BUCKET", s3Env],
    ["REA_WEB_S3_ACCESS_KEY_ID", s3Env],
    ["REA_WEB_S3_SECRET_ACCESS_KEY", s3Env],
  ])("names the missing variable %s without echoing values", (name, env) => {
    const incomplete: Record<string, string | undefined> = {
      ...env,
      [name]: undefined,
    };
    let message = "";
    try {
      createObjectStoreFromEnv(incomplete);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(name);
    for (const value of Object.values(env))
      expect(message).not.toContain(value);
  });

  it("treats an empty variable as missing and names the fs root", () => {
    expect(() =>
      createObjectStoreFromEnv({
        REA_WEB_STORAGE_BACKEND: "fs",
        REA_WEB_STORAGE_FS_ROOT: "",
      }),
    ).toThrow(/REA_WEB_STORAGE_FS_ROOT/u);
  });

  it("rejects an unknown backend or malformed flag without echoing the value", () => {
    let message = "";
    try {
      createObjectStoreFromEnv({ REA_WEB_STORAGE_BACKEND: SECRET });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("REA_WEB_STORAGE_BACKEND");
    expect(message).not.toContain(SECRET);

    message = "";
    try {
      createObjectStoreFromEnv({
        ...s3Env,
        REA_WEB_S3_FORCE_PATH_STYLE: SECRET,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("REA_WEB_S3_FORCE_PATH_STYLE");
    expect(message).not.toContain(SECRET);
  });
});
