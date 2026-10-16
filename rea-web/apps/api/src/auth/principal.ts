import type { RunnerRecord, UserRecord } from "@rea-web/db";

export interface UserPrincipal {
  readonly kind: "user";
  readonly user: UserRecord;
  readonly via: "session" | "api_token";
  /** Hash under which the session is stored (sessions only). */
  readonly sessionKey?: string;
}

export interface RunnerPrincipal {
  readonly kind: "runner";
  readonly runner: RunnerRecord;
}

export type Principal = UserPrincipal | RunnerPrincipal;

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}
