/**
 * Local validation of .railway/railway.ts without contacting Railway.
 * Evaluates the program for each environment and checks invariants the
 * deployment depends on. Run: `npm run deploy:validate` (uses tsx).
 *
 * This proves the definition is well-formed and consistent with the code.
 * It does not prove Railway accepts it: `railway config plan` (Railway CLI,
 * authenticated, linked project) is the authoritative check.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRailwayContext, project } from "railway/iac";
import { DEFAULT_SECRET_ENV_NAMES } from "@rea-web/contracts";

const here = dirname(fileURLToPath(import.meta.url));
const reaWeb = resolve(here, "../..");
const repoRoot = resolve(reaWeb, "..");

type Variable = { type: string; value?: string };
type Resource = {
  address: string;
  type: string;
  name: string;
  source?: { rootDirectory?: string };
  build?: { dockerfilePath?: string };
  variables?: Record<string, Variable>;
};

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

const documentedNames = new Set(
  [
    ...readFileSync(join(reaWeb, "docs/API.md"), "utf8").matchAll(
      /`(REA_WEB_[A-Z0-9_]+|REA_RECOVERY_[A-Z0-9_]+)`/gu,
    ),
  ].map((m) => m[1] as string),
);

const SECRET_NAMES = new Set([
  ...DEFAULT_SECRET_ENV_NAMES,
  "REA_WEB_RUNNER_TOKEN",
  "REA_WEB_SESSION_SECRET",
  "REA_WEB_S3_ACCESS_KEY_ID",
  "REA_WEB_S3_SECRET_ACCESS_KEY",
  "REA_WEB_ANTHROPIC_API_KEY",
]);
const CONTROL_PLANE_CREDENTIALS = [
  "REA_WEB_DATABASE_URL",
  "REA_WEB_SESSION_SECRET",
  "REA_WEB_S3_ACCESS_KEY_ID",
  "REA_WEB_S3_SECRET_ACCESS_KEY",
];

const mod = (await import(join(reaWeb, ".railway/railway.ts"))) as {
  default: (
    ctx: unknown,
    p: typeof project,
  ) => Promise<{ name: string; resources: Resource[] }>;
};

for (const environment of ["production", "staging"]) {
  const definition = await mod.default(
    createRailwayContext({ environment, command: "plan" }),
    project,
  );
  const byName = new Map(definition.resources.map((r) => [r.address, r]));
  const api = byName.get("service.rea-web-api");
  const runner = byName.get("service.rea-web-runner-linux");
  check(api !== undefined, `${environment}: api service missing`);
  check(runner !== undefined, `${environment}: runner service missing`);
  check(
    byName.has("database.rea-web-postgres"),
    `${environment}: postgres missing`,
  );
  check(byName.has("bucket.rea-web-objects"), `${environment}: bucket missing`);
  for (const service of [api, runner].filter(
    (s): s is Resource => s !== undefined,
  )) {
    const root = service.source?.rootDirectory
      ? join(repoRoot, service.source.rootDirectory)
      : repoRoot;
    const dockerfile = service.build?.dockerfilePath
      ? join(root, service.build.dockerfilePath)
      : null;
    check(
      dockerfile !== null && existsSync(dockerfile),
      `${service.name}: dockerfile ${dockerfile} not found`,
    );
    for (const [name, variable] of Object.entries(service.variables ?? {})) {
      if (name.startsWith("REA_WEB_"))
        check(
          documentedNames.has(name),
          `${service.name}: ${name} is not documented in docs/API.md`,
        );
      if (SECRET_NAMES.has(name))
        check(
          variable.type === "preserve" || variable.type === "reference",
          `${service.name}: secret ${name} must be preserve() or a reference, found ${variable.type}`,
        );
      if (variable.type === "literal")
        check(
          !/(sk-ant-|sk_live_|-----BEGIN|password=|:\/\/[^/\s]+:[^@\s]+@)/iu.test(
            variable.value ?? "",
          ),
          `${service.name}: ${name} literal looks like a credential`,
        );
    }
  }
  for (const name of CONTROL_PLANE_CREDENTIALS)
    check(
      !(name in (runner?.variables ?? {})),
      `runner must not hold control-plane credential ${name}`,
    );
  check(
    api?.variables?.["REA_WEB_ALLOW_REGISTRATION"]?.value ===
      (environment === "production" ? "false" : "true"),
    `${environment}: registration flag unexpected`,
  );
}

if (failures.length > 0) {
  process.stderr.write(
    `railway definition invalid:\n- ${failures.join("\n- ")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    "railway definition valid for production and staging (local checks only)\n",
  );
}
