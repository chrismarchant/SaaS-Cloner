import { ApiError } from "@rea-web/contracts";
import type { AppContext } from "../context.js";
import type { UserRecord } from "@rea-web/db";
import {
  hashPassword,
  burnPasswordWork,
  verifyPassword,
} from "../auth/password.js";
import {
  clearSessionCookie,
  newApiToken,
  startSession,
} from "../auth/credentials.js";
import { apiTokenView, membershipView, userView } from "./mappers.js";
import type { HandlersFor } from "./types.js";

const normaliseEmail = (email: string): string => email.trim().toLowerCase();

const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILURES = 10;

/** Failed-login counter per client address and email (single process). */
class LoginLimiter {
  private readonly failures = new Map<string, { n: number; until: number }>();
  check(key: string, now: number): void {
    const entry = this.failures.get(key);
    if (entry === undefined) return;
    if (entry.until <= now) {
      this.failures.delete(key);
      return;
    }
    if (entry.n >= LOGIN_MAX_FAILURES)
      throw new ApiError("rate_limited", "Too many failed login attempts", {
        retry_after_seconds: Math.ceil((entry.until - now) / 1000),
      });
  }
  fail(key: string, now: number): void {
    const entry = this.failures.get(key);
    if (entry === undefined || entry.until <= now)
      this.failures.set(key, { n: 1, until: now + LOGIN_WINDOW_MS });
    else entry.n += 1;
    if (this.failures.size > 10_000) this.failures.clear();
  }
  clear(key: string): void {
    this.failures.delete(key);
  }
}

const meResponse = async (
  ctx: AppContext,
  user: UserRecord,
  principal: "session" | "api_token",
) => {
  const projects = await ctx.repos.projects.listForUser(user.id);
  return {
    user: userView(user),
    memberships: projects.map(membershipView),
    principal,
  };
};

export const authHandlers = (): HandlersFor<
  | "register"
  | "login"
  | "logout"
  | "me"
  | "createToken"
  | "listTokens"
  | "revokeToken"
> => {
  const limiter = new LoginLimiter();
  return {
    async register({ ctx, body, reply }) {
      if (!ctx.config.allowRegistration)
        throw new ApiError("registration_disabled", "Registration is disabled");
      const email = normaliseEmail(body.email);
      const first = (await ctx.repos.users.count()) === 0;
      const user = await ctx.repos.users.create({
        email,
        password_hash: await hashPassword(body.password),
        display_name: body.display_name ?? null,
      });
      if (first) {
        try {
          await ctx.repos.projects.create({
            slug: "default",
            name: "Default",
            created_by: user.id,
          });
        } catch (error) {
          // A concurrent first registration already created it.
          if (!(error instanceof ApiError && error.code === "conflict"))
            throw error;
        }
      }
      await startSession(ctx, reply, user.id);
      return meResponse(ctx, user, "session");
    },

    async login({ ctx, body, reply, req }) {
      const email = normaliseEmail(body.email);
      const limitKey = `${req.ip}|${email}`;
      const now = ctx.now().getTime();
      limiter.check(limitKey, now);
      const user = await ctx.repos.users.findByEmail(email);
      const valid =
        user === null
          ? (await burnPasswordWork(body.password), false)
          : await verifyPassword(body.password, user.password_hash);
      if (user === null || !valid) {
        limiter.fail(limitKey, now);
        throw new ApiError("unauthorized", "Invalid email or password");
      }
      limiter.clear(limitKey);
      await startSession(ctx, reply, user.id);
      return meResponse(ctx, user, "session");
    },

    async logout({ ctx, user, reply }) {
      if (user.sessionKey !== undefined)
        await ctx.repos.sessions.delete(user.sessionKey);
      clearSessionCookie(ctx, reply);
      return { ok: true as const };
    },

    async me({ ctx, user }) {
      return meResponse(ctx, user.user, user.via);
    },

    async createToken({ ctx, user, body }) {
      const { token, hash } = newApiToken();
      const expires =
        body.expires_in_days === undefined
          ? null
          : new Date(
              ctx.now().getTime() + body.expires_in_days * 24 * 3_600_000,
            );
      const record = await ctx.repos.apiTokens.create({
        user_id: user.user.id,
        name: body.name,
        token_hash: hash,
        expires_at: expires,
      });
      return {
        id: record.id,
        name: record.name,
        token,
        expires_at: record.expires_at,
      };
    },

    async listTokens({ ctx, user }) {
      const tokens = await ctx.repos.apiTokens.listByUser(user.user.id);
      return {
        items: tokens.filter((t) => t.revoked_at === null).map(apiTokenView),
      };
    },

    async revokeToken({ ctx, user, params }) {
      const revoked = await ctx.repos.apiTokens.revoke(params.id, user.user.id);
      if (!revoked) throw new ApiError("not_found", "Token not found");
      return { ok: true as const };
    },
  };
};
