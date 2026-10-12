import type { FastifyBaseLogger } from "fastify";
import type { Database, Repositories } from "@rea-web/db";
import type { ObjectStore } from "@rea-web/storage";
import type { AppConfig } from "./config.js";
import type { IdempotencyService } from "./http/idempotency.js";
import type { JobEventBus } from "./orchestrator/eventBus.js";
import type { Fencing } from "./orchestrator/fencing.js";

/** Everything a handler may use; assembled once in `createApp`. */
export interface AppContext {
  readonly repos: Repositories;
  readonly db: Database;
  readonly store: ObjectStore;
  readonly config: AppConfig;
  readonly logger: FastifyBaseLogger;
  readonly now: () => Date;
  readonly bus: JobEventBus;
  readonly fencing: Fencing;
  readonly idempotency: IdempotencyService;
}

export interface AppDeps {
  readonly repos: Repositories;
  readonly db: Database;
  readonly store: ObjectStore;
  readonly config: AppConfig;
  readonly logger: FastifyBaseLogger;
  readonly now?: () => Date;
  readonly bus?: JobEventBus;
}
