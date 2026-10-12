import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "@rea-web/contracts";
import type { AppContext } from "../context.js";
import { randomToken, sha256Hex } from "../http/util.js";
import type { Principal, RunnerPrincipal, UserPrincipal } from "./principal.js";

export const SESSION_COOKIE = "rea_web_session";
export const API_TOKEN_PREFIX = "rwt_";
export const RUNNER_TOKEN_PREFIX = "rwr_";

export const newApiToken = (): { token: string; hash: string } => {
  const token = randomToken(API_TOKEN_PREFIX);
  return { token, hash: sha256Hex(token) };
};

export const newRunnerToken = (): { token: string; hash: string } => {
  const token = randomToken(RUNNER_TOKEN_PREFIX);
  return { token, hash: sha256Hex(token) };
};

export const bearerToken = (request: FastifyRequest): string | null => {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer[ ]+(\S+)$/iu.exec(header.trim());
  return match?.[1] ?? null;
};

const unauthorized = (): ApiError =>
  new ApiError("unauthorized", "Authentication required");

const sessionCookieOptions = (ctx: AppContext) => ({
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: ctx.config.publicUrl.startsWith("https:"),
  signed: true,
  maxAge: Math.floor(ctx.config.sessionTtlMs / 1000),
});

/** Creates a session row and sets the signed cookie. */
export const startSession = async (
  ctx: AppContext,
  reply: FastifyReply,
  userId: string,
): Promise<void> => {
  const id = randomToken("", 32);
  const expires = new Date(ctx.now().getTime() + ctx.config.sessionTtlMs);
  await ctx.repos.sessions.create({
    id: sha256Hex(id),
    user_id: userId,
    expires_at: expires,
  });
  reply.setCookie(SESSION_COOKIE, id, sessionCookieOptions(ctx));
};

export const clearSessionCookie = (
  ctx: AppContext,
  reply: FastifyReply,
): void => {
  const {
    maxAge: _maxAge,
    signed: _signed,
    ...options
  } = sessionCookieOptions(ctx);
  reply.clearCookie(SESSION_COOKIE, options);
};

const sessionPrincipal = async (
  ctx: AppContext,
  request: FastifyRequest,
): Promise<UserPrincipal | null> => {
  const raw = request.cookies[SESSION_COOKIE];
  if (typeof raw !== "string" || raw === "") return null;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) return null;
  const key = sha256Hex(unsigned.value);
  const session = await ctx.repos.sessions.findActive(key);
  if (session === null) return null;
  const user = await ctx.repos.users.findById(session.user_id);
  return user === null
    ? null
    : { kind: "user", user, via: "session", sessionKey: key };
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cookie-authenticated mutations must come from our own origin. SameSite=Lax
 * already blocks cross-site POSTs; this closes same-site sibling origins.
 */
const enforceSameOrigin = (ctx: AppContext, request: FastifyRequest): void => {
  if (SAFE_METHODS.has(request.method)) return;
  const origin = request.headers.origin;
  if (typeof origin !== "string") return;
  const allowed = new Set<string>(ctx.config.corsOrigins);
  try {
    allowed.add(new URL(ctx.config.publicUrl).origin);
  } catch {
    // publicUrl is validated at configuration time.
  }
  const host = request.headers.host;
  if (typeof host === "string") {
    allowed.add(`http://${host}`);
    allowed.add(`https://${host}`);
  }
  if (!allowed.has(origin))
    throw new ApiError("forbidden", "Cross-origin request rejected");
};

export const authenticateUser = async (
  ctx: AppContext,
  request: FastifyRequest,
): Promise<UserPrincipal> => {
  const bearer = bearerToken(request);
  if (bearer !== null) {
    if (!bearer.startsWith(API_TOKEN_PREFIX)) throw unauthorized();
    const token = await ctx.repos.apiTokens.findActiveByHash(sha256Hex(bearer));
    if (token === null) throw unauthorized();
    const user = await ctx.repos.users.findById(token.user_id);
    if (user === null) throw unauthorized();
    return { kind: "user", user, via: "api_token" };
  }
  const session = await sessionPrincipal(ctx, request);
  if (session === null) throw unauthorized();
  enforceSameOrigin(ctx, request);
  return session;
};

export const authenticateRunner = async (
  ctx: AppContext,
  request: FastifyRequest,
): Promise<RunnerPrincipal> => {
  const bearer = bearerToken(request);
  if (bearer === null || !bearer.startsWith(RUNNER_TOKEN_PREFIX))
    throw unauthorized();
  const runner = await ctx.repos.runners.findActiveByTokenHash(
    sha256Hex(bearer),
  );
  if (runner === null) throw unauthorized();
  return { kind: "runner", runner };
};

export const authenticate = async (
  ctx: AppContext,
  request: FastifyRequest,
  mode: "none" | "user" | "runner",
): Promise<Principal | null> => {
  if (mode === "user") return authenticateUser(ctx, request);
  if (mode === "runner") return authenticateRunner(ctx, request);
  return null;
};
