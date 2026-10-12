/**
 * Railway Infrastructure as Code for REA Web (control plane + optional Linux
 * runner). Evaluated by the Railway CLI (`railway config plan|apply`) from the
 * `rea-web/` directory; nothing here is applied automatically.
 *
 * Secrets are never written here: every secret is `preserve()` and must be set
 * in Railway (sealed variables recommended). Bucket credentials are linked from
 * the bucket's Credentials tab into the REA_WEB_S3_* names on the api service.
 *
 * The runner service is optional. It executes upstream REA tools that need only
 * Node and bring-your-own Linux tools; it has no Docker daemon, GUI, device or
 * macOS/Windows capability, and must not hold control-plane database or bucket
 * credentials. Provider-dependent tools stay unavailable there and the
 * capability panel shows upstream's reason and remediation.
 */
import {
  bucket,
  defineRailway,
  github,
  group,
  postgres,
  preserve,
  project,
  service,
} from "railway/iac";

const REPOSITORY = "chrismarchant/SaaS-Cloner";
const API_PORT = "8080";

export default defineRailway((ctx) => {
  const production = ctx.isEnvironment("production");

  const db = postgres("rea-web-postgres");
  const objects = bucket("rea-web-objects", { region: "iad" });

  const api = service("rea-web-api", {
    source: github(REPOSITORY, { branch: "main", rootDirectory: "rea-web" }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "deploy/docker/api.Dockerfile",
      watchPatterns: ["rea-web/**"],
    },
    preDeploy: ["node packages/db/dist/cli.js migrate"],
    healthcheck: "/api/v1/health",
    healthcheckTimeout: 60,
    replicas: 1,
    env: {
      PORT: API_PORT,
      NODE_ENV: "production",
      REA_WEB_LOG_LEVEL: "info",
      REA_WEB_DATABASE_URL: db.env.DATABASE_URL,
      REA_WEB_SESSION_SECRET: preserve(),
      REA_WEB_PUBLIC_URL: preserve(),
      REA_WEB_ALLOW_REGISTRATION: production ? "false" : "true",
      REA_WEB_STORAGE_BACKEND: "s3",
      REA_WEB_S3_ENDPOINT: preserve(),
      REA_WEB_S3_REGION: preserve(),
      REA_WEB_S3_BUCKET: preserve(),
      REA_WEB_S3_ACCESS_KEY_ID: preserve(),
      REA_WEB_S3_SECRET_ACCESS_KEY: preserve(),
      REA_WEB_S3_FORCE_PATH_STYLE: "false",
      REA_WEB_MAX_UPLOAD_BYTES: String(2 * 1024 * 1024 * 1024),
      REA_WEB_LEASE_TTL_MS: "60000",
    },
  });

  const runner = service("rea-web-runner-linux", {
    source: github(REPOSITORY, { branch: "main" }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "rea-web/deploy/docker/runner.Dockerfile",
    },
    replicas: 1,
    env: {
      NODE_ENV: "production",
      REA_WEB_LOG_LEVEL: "info",
      REA_WEB_API_PRIVATE_HOST: api.env.RAILWAY_PRIVATE_DOMAIN,
      REA_WEB_API_PORT: API_PORT,
      REA_WEB_RUNNER_TOKEN: preserve(),
      REA_WEB_RUNNER_NAME: "railway-linux",
      REA_WEB_RUNNER_LABELS: "railway,linux",
      REA_WEB_RUNNER_MAX_JOBS: "2",
      REA_WEB_RUNNER_WORKSPACE_ROOT: "/home/node/rea-web-workspace",
      REA_WEB_REA_ROOT: "/opt/rea",
      REA_WEB_MODEL_PROVIDER: preserve(),
      REA_WEB_ANTHROPIC_API_KEY: preserve(),
      REA_WEB_MODEL_ID: "claude-opus-5-5",
      REA_WEB_MODEL_MAX_OUTPUT_TOKENS: "16000",
    },
  });

  return project("rea-web", {
    resources: [
      ...group("Control plane", [db, objects, api]),
      ...group("Runners", [runner]),
    ],
  });
});
