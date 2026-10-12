#!/usr/bin/env node
import { pino } from "pino";
import {
  DEFAULT_SECRET_ENV_NAMES,
  redactorFromEnvironment,
} from "@rea-web/contracts";
import { createModelProviderFromEnv } from "@rea-web/model-connector";
import { parseRunnerConfig } from "./config.js";
import { Runner } from "./runner.js";

const main = async (): Promise<number> => {
  const env = { ...process.env };
  let config;
  try {
    config = parseRunnerConfig(env);
  } catch (error) {
    process.stderr.write(
      `rea-web-runner: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  const redactor = redactorFromEnvironment(env, [
    ...DEFAULT_SECRET_ENV_NAMES,
    ...config.passthroughNames,
  ]);
  const logger = pino({
    level: config.logLevel,
    base: { component: "runner", runner: config.runnerName },
  });
  const log = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
  ) =>
    logger[level](
      fields ? (redactor.redactValue(fields) as object) : {},
      redactor.redactText(message),
    );
  const provider = createModelProviderFromEnv(env);
  log("info", "model connector", {
    provider: provider.id,
    model: provider.model,
    available: provider.available,
    reason: provider.unavailable_reason,
  });
  const runner = new Runner({ config, env, provider, log });
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("info", "shutdown requested", { signal });
    void runner.stop({ abortJobs: true });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  await runner.register();
  await runner.run();
  return 0;
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `rea-web-runner failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
