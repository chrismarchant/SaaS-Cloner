# REA Web + Build Recovery: final report

Date: 2026-10-16.

## Identity

| Item               | Value                                                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream           | `morluto/rea@c22111eca2c4bc84a084f12711f405b3e7422a40` (`rea-agents@6.4.0`), imported with full history. Branch `upstream-baseline`. Tag `upstream-baseline-c22111e` exists locally only: pushing the tag was refused (HTTP 403) |
| Implementation     | `chrismarchant/SaaS-Cloner`, branch `claude/zen-lamport-ijxd7w`. Last code commit `f758af9a6`; this report is in the commit that follows it                                                                                      |
| Upstream integrity | `git diff --stat upstream-baseline...HEAD -- . ':(exclude)rea-web'` is empty. The upstream `npm run check:fast` and `npm run format:check` pass with the extension present                                                       |
| Pull request       | Draft PR #1 (`chrismarchant/SaaS-Cloner`) against `upstream-baseline`                                                                                                                                                            |

## Gates

| Gate                                          | Result                                        | Proof                                                                                                                                          |
| --------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| G00 baseline                                  | Done                                          | `docs/verification/G00-baseline.md`; upstream suite 9,229 passed / 2 failed / 123 skipped at the pin; both failures are attributed to upstream |
| G01 contracts and control plane               | Done                                          | `tests/e2e/investigation.test.ts`: built API and runner processes round-trip jobs                                                              |
| G02 investigation API, adapter, UI            | Done                                          | `tests/e2e/ui.test.ts`: the fixture is analysed through the UI in Chromium                                                                     |
| G03 preservation and recovery packages        | Done                                          | `tests/e2e/preservation.test.ts`, `tests/e2e/ui-preserve.test.ts`                                                                              |
| G04 standalone restore and clean verification | Done                                          | `tests/e2e/recovery.test.ts`: tar-only clean restore with the embedded verifier                                                                |
| G05 local companion runner, host routing      | Done                                          | `tests/e2e/companion.test.ts`, `docs/HOST-ROUTING.md`, `docs/COMPANION-RUNNER.md`                                                              |
| G06 platform collectors, deployment hardening | Done, with external steps outstanding (below) | S3/Supabase Storage and platform-config collectors; images pinned by digest; Railway IaC validated locally only                                |

## Architecture

`docs/ARCHITECTURE.md` and `docs/SS00.md` have the detail. The components are:

- **`@rea-web/contracts`**: the single owner of every wire shape. Route contracts, job inputs and results, the runner protocol, the recovery manifest, the restore report and the verification vocabulary. The API, runner and web UI all bind to these schemas. The browser imports `@rea-web/contracts/browser`.
- **`apps/api`**: a Fastify control plane on PostgreSQL. It provides:
  - auth (scrypt passwords, hashed sessions, Origin and Sec-Fetch-Site checks);
  - project authorization and idempotency keys;
  - uploads with SSRF and path guards;
  - durable jobs with fenced leases, a reaper and SSE events;
  - the outbound-only runner protocol;
  - static serving of the web UI.
- **`apps/runner`**: claims jobs outbound and executes them:
  - investigation run, follow-up, compare and export;
  - preservation plan and capture;
  - recovery verify and export.

  It drives the unchanged upstream REA through `@rea-web/rea-adapter`, which owns each REA process group, validates arguments against the live schema and keeps raw and derived results. Host paths are reachable only through the runner's allowlist (`path_hash`).

- **`@rea-web/preservation`**: collectors for git (bundles, submodules, LFS, working tree), dependencies, PostgreSQL, assets (local, S3, Supabase Storage), infrastructure and platform config, integrations, and Code-to-PRD product documentation.
- **`@rea-web/recovery`**: package builder, integrity, tar, Ed25519 signatures (manifest and export archive), chunked AES-256-GCM, and the standalone verifier/restorer.
- **`apps/recover-cli`**: `rea-recover.mjs`, a single-file bundle embedded in every package.
- **`apps/web`**: the Investigate and Preserve & restore UIs (React).

## Quick start (local, disposable)

```sh
# Upstream REA (unchanged), pinned toolchain from .nvmrc
npm ci && npm run build:cached
cd rea-web && npm ci && npx tsc -b tsconfig.json
npm run build -w @rea-web/web && npm run build -w @rea-web/recover-cli

# PostgreSQL 16+ reachable; then the API serving the UI:
REA_WEB_DATABASE_URL=postgres://… REA_WEB_SESSION_SECRET=<32+ random bytes> \
REA_WEB_PUBLIC_URL=http://127.0.0.1:8080 REA_WEB_STORAGE_BACKEND=fs \
REA_WEB_STORAGE_FS_ROOT=./.rea-web-data/objects REA_WEB_STATIC_DIR=apps/web/dist \
node apps/api/dist/main.js
# Register in the UI, create a runner, copy its token, then:
REA_WEB_API_URL=http://127.0.0.1:8080 REA_WEB_RUNNER_TOKEN=<token> \
REA_WEB_REA_ROOT="$PWD/.." REA_WEB_MODEL_PROVIDER=disabled node apps/runner/dist/main.js
```

`deploy/compose/compose.yaml` describes the same stack with MinIO, and `.railway/railway.ts` describes the Railway deployment (`deploy/README.md`). Neither has been run here.

## Environment variable names

The full table with meanings is in `docs/API.md#environment`; `docs/COMPANION-RUNNER.md` covers the runner. Values never appear in this repository.

- **API:** `REA_WEB_DATABASE_URL`, `REA_WEB_SESSION_SECRET`, `REA_WEB_PUBLIC_URL`, `REA_WEB_ALLOW_REGISTRATION`, `REA_WEB_MAX_UPLOAD_BYTES`, `REA_WEB_LEASE_TTL_MS`, `REA_WEB_IDEMPOTENCY_TTL_MS`, `REA_WEB_LOG_LEVEL`, `REA_WEB_VALIDATE_RESPONSES`, `REA_WEB_CORS_ORIGINS`, `REA_WEB_STATIC_DIR`, `REA_WEB_HOST`, `REA_WEB_PORT`, `PORT`
- **Storage:** `REA_WEB_STORAGE_BACKEND`, `REA_WEB_STORAGE_FS_ROOT`, `REA_WEB_S3_ENDPOINT`, `REA_WEB_S3_REGION`, `REA_WEB_S3_BUCKET`, `REA_WEB_S3_PREFIX`, `REA_WEB_S3_ACCESS_KEY_ID`, `REA_WEB_S3_SECRET_ACCESS_KEY`, `REA_WEB_S3_FORCE_PATH_STYLE`
- **Runner:** `REA_WEB_API_URL`, `REA_WEB_API_PRIVATE_HOST`, `REA_WEB_API_PORT`, `REA_WEB_RUNNER_TOKEN`, `REA_WEB_RUNNER_NAME`, `REA_WEB_RUNNER_LABELS`, `REA_WEB_RUNNER_WORKSPACE_ROOT`, `REA_WEB_RUNNER_MAX_JOBS`, `REA_WEB_RUNNER_SESSION_IDLE_MS`, `REA_WEB_RUNNER_LOCAL_TARGET_ALLOWLIST`, `REA_WEB_REA_ROOT`, `REA_WEB_REA_PASSTHROUGH_ENV`, `REA_WEB_RECOVER_BUNDLE`, `REA_WEB_CODE_TO_PRD_DIR`, `REA_WEB_RECOVERY_KEYS_DIR`, `REA_WEB_EXPORT_SIGNING_KEYS_DIR`, `REA_WEB_VERIFY_DATABASE_ADMIN_URL`, `REA_WEB_VERIFY_ALLOW_NETWORK`
- **Model:** `REA_WEB_MODEL_PROVIDER`, `REA_WEB_ANTHROPIC_API_KEY`, `REA_WEB_ANTHROPIC_BASE_URL`, `REA_WEB_MODEL_ID`, `REA_WEB_MODEL_FALLBACKS`, `REA_WEB_MODEL_MAX_OUTPUT_TOKENS`
- **Capture credentials:** any names a build declares, for example `connection_env_name` or `<PREFIX>_ACCESS_KEY_ID`. They are read only on the runner.

## Test evidence (2026-10-16, this container)

These runs used local PostgreSQL 16, the built upstream REA MCP server and the preinstalled Chromium 141.

| Project                        | Tests                    |
| ------------------------------ | ------------------------ |
| contracts                      | 118                      |
| db                             | 43                       |
| storage                        | 103                      |
| recovery                       | 113                      |
| recover-cli                    | 11                       |
| preservation                   | 161                      |
| model-connector                | 7                        |
| rea-adapter                    | 6                        |
| runner                         | 17                       |
| api                            | 113                      |
| web                            | 77                       |
| **Unit and integration total** | **769 passed, 0 failed** |
| e2e investigation              | 3                        |
| e2e preservation               | 5                        |
| e2e recovery                   | 9                        |
| e2e companion                  | 2                        |
| e2e ui                         | 17                       |
| e2e ui-preserve                | 10                       |
| **End-to-end total**           | **46 passed, 0 failed**  |

To reproduce:

```sh
REA_WEB_TEST_DATABASE_URL=postgres://… npx vitest run --project <name>
REA_WEB_TEST_DATABASE_URL=postgres://… npx vitest run --project e2e tests/e2e/<suite>.test.ts
```

## Host and provider matrix

`docs/HOST-ROUTING.md` is generated from the routing table and live probes; `docs/PARITY-MATRIX.md` covers all 173 upstream tools. Only one host was probed: linux-x64, with no providers installed. On it:

- `apk`, `elf_core`, `wasm` and `firmware_image` routes are unavailable, with upstream's `provider_missing` remediation;
- `website_url` needs the `rea-cdp-browser` provider.

macOS, Windows and provider-equipped hosts were not probed and are not claimed.

## Recovery example (what the G04 test runs)

```sh
# Platform: plan → capture → export (optionally --encrypt / --sign) in the UI or API.
# Elsewhere, with only the archive:
node rea-recover.mjs verify export.tar --archive-signature export.sig.json --archive-key signer.pem
node rea-recover.mjs unpack export.tar --out pkg/            # or export.tar.enc --key-file <key>
DB=postgres://…/empty_disposable_db \
node pkg/*/recovery/rea-recover.mjs restore pkg/* --scope clean_build,data_restore,behavior \
  --target restored/ --database-url-env DB --allow-network registry --report report.json
```

Observed on the fixture:

- Overall status `behavior_verified`.
- The restored tree matches byte for byte, including modified and untracked files, with no `.env`.
- The database invariant holds.
- Network verdict `yes`, because `npm ci` needs a registry.
- No secret or password appears in the report or output.
- A tampered archive, a blocked database host, or a registry step without `--allow-network` is refused or blocked.

## Independent review

Codex review packages 1 to 4 are prepared in `docs/review-packages/`:

1. Baseline and architecture.
2. End-to-end investigation.
3. End-to-end recovery.
4. Final integration.

**No Codex review has been performed.** Each package carries an empty review record to be filled from the review session.

## Known limitations

- **Model:** no live model call was made, because there is no approved budget. The connector and follow-up loop are covered by a scripted provider only.
- **Not run here (no Docker daemon, no credentials):**
  - real S3, a real Supabase project, Railway (`railway config plan`/`apply`);
  - container image builds and the compose stack;
  - remote git over the network;
  - cross-host restore;
  - restore on hosts without user namespaces, where steps run unisolated and the report says so.
- **Providers and platforms:** provider-backed upstream tools (Ghidra, Hopper, IDA, JADX, Binwalk/Unblob, WABT, Chromium, ADB) were not installed or exercised. macOS and Windows runners are untested. On Windows only the direct REA child is terminated.
- **Images:** base images are pinned by digests fetched from `mirror.gcr.io`, because Docker Hub rate-limited this environment. They have not been cross-checked against Docker Hub. The MinIO compose tags are unverified.
- **Restore safety:** restore steps run with the invoking user's filesystem rights. Untrusted packages should be restored inside a container.
- **Not implemented:**
  - secret escrow (refused with a reason);
  - live platform APIs and dashboard-only settings;
  - evaluation of Railway TypeScript IaC during capture.
- **Duplication:** Supabase data components still emit generic manual prerequisites beside the specific ones from platform config.
- **Unproved UI paths:** the signing UI, over-2 MiB raw results and EventSource reconnection have no browser test.

## Remaining external configuration (operator)

1. Create the Railway project. Run `railway config plan`/`apply` from `rea-web/`, then set the preserved variables, as described in `deploy/README.md`.
2. Re-check the image digests against Docker Hub. Confirm and pin the MinIO tags if you use the compose stack.
3. Create runners in the UI and start them, cloud or companion, with their tokens. For each one:
   - set the allowlist;
   - set restore-only database credentials (`REA_WEB_VERIFY_DATABASE_ADMIN_URL`);
   - place recovery and signing keys outside every package.
4. Approve a model budget and set `REA_WEB_MODEL_PROVIDER=anthropic` with `REA_WEB_ANTHROPIC_API_KEY`, or leave it `disabled`.
5. Keep copies of exports outside the platform's failure domain.
6. Run the Codex reviews from the four packages and record their findings.
