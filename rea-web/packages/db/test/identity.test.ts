import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "@rea-web/contracts";
import { type TestDatabase, createTestDatabase, describeDb } from "./testDatabase.js";
import { seedProject, seedRunner } from "./fixtures.js";

const past = () => new Date(Date.now() - 60_000);
const future = () => new Date(Date.now() + 60_000);

describeDb("identity and fleet repositories", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.drop();
  });

  it("users: create, lookup, count, duplicate email conflicts", async () => {
    const { repos } = t;
    const before = await repos.users.count();
    const user = await repos.users.create({
      email: "dup@example.test",
      password_hash: "h",
    });
    expect(user.display_name).toBeNull();
    expect(Date.parse(user.created_at)).not.toBeNaN();
    expect(await repos.users.findByEmail("dup@example.test")).toEqual(user);
    expect(await repos.users.findById(user.id)).toEqual(user);
    expect(await repos.users.count()).toBe(before + 1);
    await expect(
      repos.users.create({ email: "dup@example.test", password_hash: "h" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("sessions: expired sessions are not active and are purged", async () => {
    const { repos } = t;
    const { user } = await seedProject(repos);
    await repos.sessions.create({ id: "live", user_id: user.id, expires_at: future() });
    await repos.sessions.create({ id: "dead", user_id: user.id, expires_at: past() });
    expect((await repos.sessions.findActive("live"))?.user_id).toBe(user.id);
    expect(await repos.sessions.findActive("dead")).toBeNull();
    expect(await repos.sessions.deleteExpired()).toBe(1);
    expect(await repos.sessions.delete("live")).toBe(true);
    expect(await repos.sessions.findActive("live")).toBeNull();
  });

  it("apiTokens: revoked and expired tokens are not found; use is recorded", async () => {
    const { repos } = t;
    const { user } = await seedProject(repos);
    const live = await repos.apiTokens.create({ user_id: user.id, name: "ci", token_hash: "t-live" });
    await repos.apiTokens.create({ user_id: user.id, name: "old", token_hash: "t-old", expires_at: past() });
    const revoked = await repos.apiTokens.create({ user_id: user.id, name: "gone", token_hash: "t-rev" });

    expect(live.last_used_at).toBeNull();
    const found = await repos.apiTokens.findActiveByHash("t-live");
    expect(found?.id).toBe(live.id);
    expect(found?.last_used_at).not.toBeNull();
    expect(await repos.apiTokens.findActiveByHash("t-old")).toBeNull();

    expect(await repos.apiTokens.revoke(revoked.id, user.id)).toBe(true);
    expect(await repos.apiTokens.findActiveByHash("t-rev")).toBeNull();
    const other = await repos.users.create({ email: "other-tok@example.test", password_hash: "h" });
    expect(await repos.apiTokens.revoke(live.id, other.id)).toBe(false);
    expect((await repos.apiTokens.listByUser(user.id)).length).toBe(3);
  });

  it("projects: create inserts the owner membership; roleFor and listForUser report it", async () => {
    const { repos } = t;
    const { user, project } = await seedProject(repos);
    expect(await repos.memberships.roleFor(project.id, user.id)).toBe("owner");
    expect(await repos.projects.findById(project.id)).toEqual(project);
    expect(await repos.projects.findBySlug(project.slug)).toEqual(project);

    const viewer = await repos.users.create({ email: "viewer@example.test", password_hash: "h" });
    expect(await repos.memberships.roleFor(project.id, viewer.id)).toBeNull();
    await repos.memberships.upsert({ project_id: project.id, user_id: viewer.id, role: "viewer" });
    await repos.memberships.upsert({ project_id: project.id, user_id: viewer.id, role: "admin" });
    expect(await repos.memberships.roleFor(project.id, viewer.id)).toBe("admin");

    const listed = await repos.projects.listForUser(viewer.id);
    expect(listed.map((p) => [p.id, p.role])).toEqual([[project.id, "admin"]]);
    const members = await repos.memberships.list(project.id);
    expect(members.map((m) => m.role).sort()).toEqual(["admin", "owner"]);

    await expect(
      repos.projects.create({ slug: project.slug, name: "x", created_by: user.id }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(await repos.memberships.remove(project.id, viewer.id)).toBe(true);
  });

  it("runners: token lookup ignores revoked; capabilities, touch and stale marking", async () => {
    const { repos, db } = t;
    const { project } = await seedProject(repos);
    const runner = await seedRunner(repos, project.id);
    expect(runner.status).toBe("never_connected");
    expect(runner.labels).toEqual(["linux"]);
    expect((await repos.runners.findActiveByTokenHash(runner.token_hash))?.id).toBe(runner.id);

    const report = { host: { os: "linux" } };
    const updated = await repos.runners.updateCapabilities(runner.id, {
      capability_report: report,
      capability_digest: { tools_available: ["a"] },
    });
    expect(updated?.status).toBe("online");
    expect(updated?.capability_report).toEqual(report);
    expect(updated?.last_seen_at).not.toBeNull();

    await db.query("UPDATE runners SET last_seen_at = now() - interval '10 minutes' WHERE id = $1", [runner.id]);
    expect(await repos.runners.markStale(60_000)).toEqual([runner.id]);
    expect((await repos.runners.findById(project.id, runner.id))?.status).toBe("stale");
    await repos.runners.touch(runner.id);
    expect((await repos.runners.findById(undefined, runner.id))?.status).toBe("online");

    const revoked = await repos.runners.revoke(runner.id);
    expect(revoked?.status).toBe("revoked");
    expect(await repos.runners.findActiveByTokenHash(runner.token_hash)).toBeNull();
    expect(await repos.runners.updateCapabilities(runner.id, { capability_report: {}, capability_digest: {} })).toBeNull();
    expect(await repos.runners.findById("00000000-0000-4000-8000-000000000000", runner.id)).toBeNull();
    expect((await repos.runners.list(project.id)).length).toBe(1);
  });

  describe("targets", () => {
    it("creates, scopes to the project, pages newest first, and refuses to delete referenced targets", async () => {
      const { repos } = t;
      const { user, project } = await seedProject(repos);
      const { project: other } = await seedProject(repos);
      const targets = [];
      for (let i = 0; i < 5; i++) {
        targets.push(
          await repos.targets.create({
            project_id: project.id,
            kind: "upload",
            name: `t${i}`,
            class: "binary",
            size: 10 + i,
            metadata: { i },
            created_by: user.id,
          }),
        );
      }
      expect(targets[0]?.size).toBe(10);
      expect(targets[0]?.metadata).toEqual({ i: 0 });
      expect(await repos.targets.findById(other.id, targets[0]?.id ?? "")).toBeNull();

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await repos.targets.list(project.id, { cursor, limit: 2 });
        seen.push(...page.items.map((x) => x.name));
        cursor = page.next_cursor ?? undefined;
        pages += 1;
      } while (cursor !== undefined);
      expect(pages).toBe(3);
      expect(seen).toEqual(["t4", "t3", "t2", "t1", "t0"]);
      await expect(repos.targets.list(project.id, { cursor: "bogus" })).rejects.toMatchObject({
        code: "validation_failed",
      });

      const target = targets[0]!;
      await repos.investigations.create({
        project_id: project.id,
        target_id: target.id,
        question: "q",
        policy: {},
        created_by: user.id,
      });
      await expect(repos.targets.delete(project.id, target.id)).rejects.toMatchObject({ code: "conflict" });
      expect(await repos.targets.delete(project.id, targets[1]?.id ?? "")).toBe(true);
    });
  });
});
