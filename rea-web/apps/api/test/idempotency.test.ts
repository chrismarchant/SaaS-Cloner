import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createIdempotencyService,
  KeyedMutex,
} from "../src/http/idempotency.js";
import { createSealer } from "../src/http/util.js";
import {
  type Account,
  type Harness,
  createHarness,
  describeDb,
} from "./helpers/harness.js";

describe("KeyedMutex", () => {
  it("runs same-key tasks one at a time and different keys concurrently", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const slow = mutex.run("k", async () => {
      order.push("a:start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a:end");
    });
    const same = mutex.run("k", async () => {
      order.push("b");
    });
    const other = mutex.run("other", async () => {
      order.push("c");
    });
    await Promise.all([slow, same, other]);
    expect(order.indexOf("a:end")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("a:end"));
  });
});

describe("sealed responses", () => {
  it("round-trips and rejects tampering or a different secret", () => {
    const sealer = createSealer("secret-one-secret-one", "p");
    const sealed = sealer.seal('{"token":"rwr_abc"}');
    expect(sealed).not.toContain("rwr_abc");
    expect(sealer.open(sealed)).toBe('{"token":"rwr_abc"}');
    expect(sealer.open(`${sealed}x`)).toBeNull();
    expect(createSealer("another-secret-value", "p").open(sealed)).toBeNull();
    expect(createSealer("secret-one-secret-one", "q").open(sealed)).toBeNull();
    expect(typeof createIdempotencyService).toBe("function");
  });
});

describeDb("Idempotency-Key", () => {
  let h: Harness;
  let alice: Account;
  let bob: Account;
  beforeAll(async () => {
    h = await createHarness();
    alice = await h.register("alice@example.com");
    bob = await h.register("bob@example.com");
  });
  afterAll(async () => {
    await h.close();
  });

  const create = (
    account: Account,
    key: string | null,
    slug: string,
    name = "Name",
  ) =>
    h.api("POST", "/api/v1/projects", {
      auth: account.auth,
      body: { slug, name },
      headers: key === null ? {} : { "idempotency-key": key },
    });

  it("replays the stored response for the same key and body, creating one row", async () => {
    const first = await create(alice, "key-1", "idem-one");
    const second = await create(alice, "key-1", "idem-one");
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.json).toEqual(first.json);
    expect(second.headers["idempotent-replay"]).toBe("true");
    expect(first.headers["idempotent-replay"]).toBeUndefined();
    const rows = await h.db.query(
      "SELECT 1 FROM projects WHERE slug = 'idem-one'",
    );
    expect(rows.rowCount).toBe(1);
  });

  it("treats key order inside the body as irrelevant", async () => {
    const first = await h.api("POST", "/api/v1/projects", {
      auth: alice.auth,
      payload: '{"slug":"idem-order","name":"N"}',
      headers: {
        "content-type": "application/json",
        "idempotency-key": "order-1",
      },
    });
    const second = await h.api("POST", "/api/v1/projects", {
      auth: alice.auth,
      payload: '{"name":"N","slug":"idem-order"}',
      headers: {
        "content-type": "application/json",
        "idempotency-key": "order-1",
      },
    });
    expect(second.status).toBe(first.status);
    expect(second.json.id).toBe(first.json.id);
  });

  it("rejects the same key with a different body as idempotency_conflict", async () => {
    await create(alice, "key-2", "idem-two");
    const conflict = await create(alice, "key-2", "idem-two-different");
    expect(conflict.status).toBe(422);
    expect(conflict.json.error.code).toBe("idempotency_conflict");
    const rows = await h.db.query(
      "SELECT 1 FROM projects WHERE slug = 'idem-two-different'",
    );
    expect(rows.rowCount).toBe(0);
  });

  it("scopes keys to the principal", async () => {
    const a = await create(alice, "shared-key", "idem-alice");
    const b = await create(bob, "shared-key", "idem-bob");
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.json.id).not.toBe(a.json.id);
  });

  it("does not store failures, so a corrected retry with the same key succeeds", async () => {
    const bad = await h.api("POST", "/api/v1/projects", {
      auth: alice.auth,
      body: { slug: "BAD SLUG", name: "x" },
      headers: { "idempotency-key": "retry-1" },
    });
    expect(bad.status).toBe(400);
    const good = await create(alice, "retry-1", "idem-retry");
    expect(good.status).toBe(201);
  });

  it("runs concurrent requests with one key once", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => create(alice, "race-1", "idem-race")),
    );
    expect(new Set(results.map((r) => r.status))).toEqual(new Set([201]));
    expect(new Set(results.map((r) => r.json.id)).size).toBe(1);
    const rows = await h.db.query(
      "SELECT 1 FROM projects WHERE slug = 'idem-race'",
    );
    expect(rows.rowCount).toBe(1);
  });

  it("validates the key and ignores it on non-idempotent routes", async () => {
    const tooLong = await create(alice, "k".repeat(129), "idem-long");
    expect(tooLong.status).toBe(400);
    const spaced = await create(alice, "has space", "idem-space");
    expect(spaced.status).toBe(400);
    const plain = await create(alice, null, "idem-plain");
    expect(plain.status).toBe(201);
  });

  it("keeps freshly issued runner tokens out of the stored record while replaying them", async () => {
    const projectId = alice.defaultProjectId as string;
    const call = () =>
      h.api("POST", `/api/v1/projects/${projectId}/runners`, {
        auth: alice.auth,
        body: { name: "idem-runner", labels: [] },
        headers: { "idempotency-key": "runner-1" },
      });
    const first = await call();
    const second = await call();
    expect(first.status).toBe(201);
    expect(second.json.token).toBe(first.json.token);
    expect(second.json.id).toBe(first.json.id);
    const runners = await h.repos.runners.list(projectId);
    expect(runners.filter((r) => r.name === "idem-runner")).toHaveLength(1);
    const stored = await h.db.query<{ response: unknown }>(
      "SELECT response FROM idempotency_records WHERE idempotency_key = 'runner-1'",
    );
    expect(JSON.stringify(stored.rows[0]?.response)).not.toContain(
      first.json.token,
    );
  });
});
