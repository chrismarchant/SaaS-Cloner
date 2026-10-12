import { afterAll, beforeAll, expect, it } from "vitest";
import { main } from "../src/cli.js";
import {
  type TestDatabase,
  createTestDatabase,
  describeDb,
} from "./testDatabase.js";

const sink = () => {
  const chunks: string[] = [];
  return { chunks, write: (text: string) => chunks.push(text) };
};

it("rejects unknown commands and a missing connection string without printing secrets", async () => {
  const out = sink();
  const err = sink();
  expect(await main(["nope"], {}, out, err)).toBe(2);
  expect(await main(["migrate"], {}, out, err)).toBe(2);
  expect(err.chunks.join("")).toContain("REA_WEB_DATABASE_URL is not set");
  expect(out.chunks).toEqual([]);
});

describeDb("cli migrate", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase({ migrate: false });
  });
  afterAll(async () => {
    await t.drop();
  });

  it("migrates using REA_WEB_DATABASE_URL and is idempotent", async () => {
    const env = { REA_WEB_DATABASE_URL: t.url };
    const first = sink();
    expect(await main(["migrate"], env, first, sink())).toBe(0);
    expect(first.chunks.join("")).toContain("0001_initial");
    const second = sink();
    expect(await main(["migrate"], env, second, sink())).toBe(0);
    expect(second.chunks.join("")).toContain("applied: none");
  });

  it("reports failures without echoing the connection string", async () => {
    const err = sink();
    const url = new URL(t.url);
    url.password = "super-secret-password";
    url.port = "1";
    expect(
      await main(
        ["migrate"],
        { REA_WEB_DATABASE_URL: url.toString() },
        sink(),
        err,
      ),
    ).toBe(1);
    expect(err.chunks.join("")).not.toContain("super-secret-password");
  });
});
