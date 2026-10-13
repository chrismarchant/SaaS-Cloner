import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import {
  type Harness,
  cookieFrom,
  createHarness,
  describeDb,
} from "./helpers/harness.js";

describe("password hashing", () => {
  it("uses scrypt with a random salt and verifies in constant shape", async () => {
    const a = await hashPassword("correct horse battery staple");
    const b = await hashPassword("correct horse battery staple");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", a)).toBe(true);
    expect(await verifyPassword("wrong password entirely", a)).toBe(false);
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
    expect(
      await verifyPassword("anything", "scrypt$99999999999$8$1$AA$AA"),
    ).toBe(false);
  });
});

describeDb("accounts and credentials", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("registers the first user with a default project they own", async () => {
    const response = await h.api("POST", "/api/v1/auth/register", {
      body: {
        email: "First@Example.com",
        password: "correct horse battery staple",
      },
    });
    expect(response.status).toBe(201);
    expect(response.json.user.email).toBe("first@example.com");
    expect(response.json.principal).toBe("session");
    expect(response.json.memberships).toHaveLength(1);
    expect(response.json.memberships[0]).toMatchObject({
      project_slug: "default",
      role: "owner",
    });
    const setCookie = String(response.headers["set-cookie"]);
    expect(setCookie).toContain("rea_web_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Secure");
    // The password hash never leaves the server.
    expect(response.raw).not.toContain("scrypt$");
    const stored = await h.repos.users.findByEmail("first@example.com");
    expect(stored?.password_hash.startsWith("scrypt$")).toBe(true);
  });

  it("does not give later users a default project and rejects duplicate emails", async () => {
    const second = await h.register("second@example.com");
    expect(second.defaultProjectId).toBeNull();
    const duplicate = await h.api("POST", "/api/v1/auth/register", {
      body: {
        email: "second@example.com",
        password: "correct horse battery staple",
      },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.json.error.code).toBe("conflict");
    const weak = await h.api("POST", "/api/v1/auth/register", {
      body: { email: "weak@example.com", password: "short" },
    });
    expect(weak.status).toBe(400);
  });

  it("logs in, resolves me, and logs out invalidating the session", async () => {
    const bad = await h.api("POST", "/api/v1/auth/login", {
      body: { email: "first@example.com", password: "not the password" },
    });
    expect(bad.status).toBe(401);
    const unknown = await h.api("POST", "/api/v1/auth/login", {
      body: { email: "nobody@example.com", password: "not the password" },
    });
    expect(unknown.status).toBe(401);
    expect(unknown.json.error.message).toBe(bad.json.error.message);

    const login = await h.api("POST", "/api/v1/auth/login", {
      body: {
        email: "first@example.com",
        password: "correct horse battery staple",
      },
    });
    expect(login.status).toBe(200);
    const cookie = cookieFrom(login.headers) as string;
    const me = await h.api("GET", "/api/v1/auth/me", { auth: { cookie } });
    expect(me.status).toBe(200);
    expect(me.json.user.email).toBe("first@example.com");

    const logout = await h.api("POST", "/api/v1/auth/logout", {
      auth: { cookie },
    });
    expect(logout.status).toBe(200);
    expect(logout.json).toEqual({ ok: true });
    const after = await h.api("GET", "/api/v1/auth/me", { auth: { cookie } });
    expect(after.status).toBe(401);
  });

  it("rejects missing, forged and tampered session cookies", async () => {
    const missing = await h.api("GET", "/api/v1/auth/me");
    expect(missing.status).toBe(401);
    const account = await h.register("cookies@example.com");
    const value = account.cookie.split("=")[1] as string;
    const [id] = value.split(".");
    const unsigned = await h.api("GET", "/api/v1/auth/me", {
      auth: { cookie: `rea_web_session=${id}` },
    });
    expect(unsigned.status).toBe(401);
    const tampered = await h.api("GET", "/api/v1/auth/me", {
      auth: { cookie: `${account.cookie}x` },
    });
    expect(tampered.status).toBe(401);
  });

  it("stores sessions hashed so a database read cannot replay them", async () => {
    const account = await h.register("hashed@example.com");
    const id = decodeURIComponent(
      (account.cookie.split("=")[1] as string).split(".")[0] as string,
    );
    expect(await h.repos.sessions.findActive(id)).toBeNull();
  });

  it("rejects cross-origin cookie-authenticated mutations", async () => {
    const account = await h.register("origin@example.com");
    const response = await h.api("POST", "/api/v1/auth/tokens", {
      auth: account.auth,
      headers: { origin: "https://evil.example" },
      body: { name: "x" },
    });
    expect(response.status).toBe(403);
    const sameOrigin = await h.api("POST", "/api/v1/auth/tokens", {
      auth: account.auth,
      headers: { origin: "http://localhost:8080" },
      body: { name: "ok" },
    });
    expect(sameOrigin.status).toBe(201);
    // Browsers mark cross-site requests even when Origin is absent.
    const fetchSite = await h.api("POST", "/api/v1/auth/tokens", {
      auth: account.auth,
      headers: { "sec-fetch-site": "same-site" },
      body: { name: "sibling" },
    });
    expect(fetchSite.status).toBe(403);
    const sameSite = await h.api("POST", "/api/v1/auth/tokens", {
      auth: account.auth,
      headers: { "sec-fetch-site": "same-origin" },
      body: { name: "same" },
    });
    expect(sameSite.status).toBe(201);
  });

  it("rejects cross-origin login and registration (login CSRF)", async () => {
    await h.register("victim-login@example.com");
    const login = await h.api("POST", "/api/v1/auth/login", {
      headers: { origin: "https://evil.example" },
      body: { email: "victim-login@example.com", password: "x".repeat(16) },
    });
    expect(login.status).toBe(403);
    const register = await h.api("POST", "/api/v1/auth/register", {
      headers: { "sec-fetch-site": "cross-site" },
      body: { email: "planted@example.com", password: "y".repeat(16) },
    });
    expect(register.status).toBe(403);
    expect(await h.repos.users.findByEmail("planted@example.com")).toBeNull();
  });

  it("creates, uses, lists and revokes API tokens (returned once, stored hashed)", async () => {
    const account = await h.register("tokens@example.com");
    const created = await h.api("POST", "/api/v1/auth/tokens", {
      auth: account.auth,
      body: { name: "ci", expires_in_days: 30 },
    });
    expect(created.status).toBe(201);
    const token = created.json.token as string;
    expect(token.startsWith("rwt_")).toBe(true);
    expect(created.json.expires_at).not.toBeNull();

    const me = await h.api("GET", "/api/v1/auth/me", {
      auth: { bearer: token },
    });
    expect(me.status).toBe(200);
    expect(me.json.principal).toBe("api_token");

    const list = await h.api("GET", "/api/v1/auth/tokens", {
      auth: account.auth,
    });
    expect(list.json.items).toHaveLength(1);
    expect(JSON.stringify(list.json)).not.toContain(token);
    const rows = await h.db.query<{ token_hash: string }>(
      "SELECT token_hash FROM api_tokens WHERE id = $1",
      [created.json.id],
    );
    expect(rows.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(rows.rows[0]?.token_hash).not.toContain(token);

    const runnerLike = await h.api("GET", "/api/v1/auth/me", {
      auth: { bearer: "rwr_nope" },
    });
    expect(runnerLike.status).toBe(401);

    const revoke = await h.api(
      "DELETE",
      `/api/v1/auth/tokens/${created.json.id}`,
      {
        auth: account.auth,
      },
    );
    expect(revoke.status).toBe(200);
    const again = await h.api("GET", "/api/v1/auth/me", {
      auth: { bearer: token },
    });
    expect(again.status).toBe(401);
    const missing = await h.api(
      "DELETE",
      `/api/v1/auth/tokens/${created.json.id}`,
      {
        auth: account.auth,
      },
    );
    expect(missing.status).toBe(404);
  });

  it("does not let one user revoke another user's token", async () => {
    const a = await h.register("owner-a@example.com");
    const b = await h.register("owner-b@example.com");
    const created = await h.api("POST", "/api/v1/auth/tokens", {
      auth: a.auth,
      body: { name: "a" },
    });
    const attempt = await h.api(
      "DELETE",
      `/api/v1/auth/tokens/${created.json.id}`,
      {
        auth: b.auth,
      },
    );
    expect(attempt.status).toBe(404);
    const stillWorks = await h.api("GET", "/api/v1/auth/me", {
      auth: { bearer: created.json.token },
    });
    expect(stillWorks.status).toBe(200);
  });

  it("rate limits repeated failed logins for one address and email", async () => {
    let status = 0;
    for (let i = 0; i < 12; i += 1) {
      const response = await h.api("POST", "/api/v1/auth/login", {
        body: { email: "brute@example.com", password: "wrong password here" },
      });
      status = response.status;
    }
    expect(status).toBe(429);
  });
});

describeDb("registration disabled", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ allowRegistration: false });
  });
  afterAll(async () => {
    await h.close();
  });

  it("refuses registration with registration_disabled", async () => {
    const response = await h.api("POST", "/api/v1/auth/register", {
      body: {
        email: "late@example.com",
        password: "correct horse battery staple",
      },
    });
    expect(response.status).toBe(403);
    expect(response.json.error.code).toBe("registration_disabled");
    expect(await h.repos.users.count()).toBe(0);
  });
});

describeDb("secure cookies", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ publicUrl: "https://rea.example.com" });
  });
  afterAll(async () => {
    await h.close();
  });

  it("marks the session cookie Secure when the public URL is https", async () => {
    const response = await h.api("POST", "/api/v1/auth/register", {
      body: {
        email: "secure@example.com",
        password: "correct horse battery staple",
      },
    });
    expect(String(response.headers["set-cookie"])).toContain("Secure");
  });
});
