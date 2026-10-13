# Progress

Updated at each gate checkpoint. Newest first.

## Checkpoint: G03 and G04 complete; G02 UI in progress — 2026-10-13 00:50 UTC

- **Branch / SHA**: `claude/zen-lamport-ijxd7w` at `61032ba8e` (pushed). Upstream unchanged.
- **G03 evidence** (`tests/e2e/preservation.test.ts`, 4/4, built API + runner + PostgreSQL). A build declared on the preservation fixture is planned and captured on the runner. The fixture has git with a submodule, LFS and uncommitted work, plus PostgreSQL with its own role and an assets directory. The capture credential exists only on the runner. The fixture secret and the DB password appear in no stored file, result or log. The capture is then:
  - exported as a tar, and as an AES-256-GCM archive encrypted to a runner-held key, which is decrypted, unpacked and integrity-verified outside the platform;
  - verified through the API with integrity, clean_build, data_restore and behavior all verified.
- **G04 evidence** (`tests/e2e/recovery.test.ts`, 9/9). Only the exported tar is copied into a clean directory. The `rea-recover.mjs` bundle embedded in the package restores clean_build, data_restore and behavior, with only `PATH` and one database variable in the environment (overall `behavior_verified`). The restored tree matches byte for byte and the invariant holds. Three negatives:
  - tamper → exit 3, all scopes blocked;
  - blocked host → data_restore blocked;
  - registry step without `--allow-network` → blocked, verdict `yes`.
- **Defects found by integration and fixed at their owners**:
  - The API silently dropped job results that did not parse. One per-kind contract now applies, and a mismatch is rejected with a 400.
  - Packages rebuilt from storage lacked their derived files. The recovery package now owns their generation.
  - A git build source could name any repository on the runner host. Host paths now resolve only through the runner allowlist (`path_hash`); remote URLs must pass the SSRF guard and carry no credentials.
  - Restore-step validation missed shells invoked by path and launchers, and never checked `cwd`. A `database` network class was added.
- **Test counts at this SHA**: contracts 118, db 41, storage 103, recovery 111 (5 skipped without isolation), recover-cli 11, preservation 45, model-connector 7, rea-adapter 6, runner 17, api 108, e2e investigation 3, preservation 4, recovery 9.
- **Not verified**:
  - A restore on a host where user namespaces are unavailable. Steps then run unisolated, and the report says so.
  - Registry access during restore: the fixture has no dependencies.
  - S3 assets: blocked pending the SDK dependency.
  - Export signing and secret escrow: refused with a reason.
  - Any cross-host restore.
- **In progress**: WP09 web UI (Sonnet). Then come Codex review packages 2 and 3, G05 (local companion runner, host routing) and G06 (platform collectors, deployment hardening).

## Checkpoint: G01 complete — 2026-10-13 00:05 UTC

- **Gate evidence**: `tests/e2e/investigation.test.ts` runs the built API (`apps/api/dist/main.js`) and runner (`apps/runner/dist/main.js`) as separate processes against a fresh PostgreSQL database, a filesystem object store and the built upstream REA MCP server. It covers the register → runner online → upload → routing → investigation → tool calls → findings → evidence bundle → job events → follow-up flow, asserting that both processes' logs contain neither the session secret nor the runner token. Command: `REA_WEB_TEST_DATABASE_URL=… npx vitest run --project e2e` → 1/1 (about 19 s). The model provider is disabled (no approved budget), so the model follow-up loop is recorded as unavailable.
- **Defects found by integration and fixed at their owners**:
  - Tool-call `seq` was session-local while stored per investigation. Calls from a second session were silently dropped. The control plane now allocates `seq` (migration 0002).
  - The API refused every follow-up after a successful run because it inferred session liveness from job state. Follow-ups now route to the runner that executed the run (`jobs.last_runner_id`, migration 0003); that runner reports `session_closed` itself.
- **API** (WP03/04, Sonnet; reviewed and integrated): 106 tests against PostgreSQL. Browser writes, including login and registration, must come from the API's own origin (`Origin`, and `Sec-Fetch-Site` when `Origin` is absent); bearer-token clients are exempt.

## Checkpoint: G01 in progress, G03 recovery core done — 2026-10-12 23:50 UTC

- **Branch / SHA**: `claude/zen-lamport-ijxd7w` at `4359ce2b6` (pushed). Upstream baseline unchanged: `git diff --stat upstream-baseline...HEAD -- . ':(exclude)rea-web'` is empty.
- **Gate status**: G00 complete. G01 not yet complete: every component of the control plane exists except the API server, which is being finished; the gate closes when a runner round-trips a job through the real API (not the test fake control plane).

### Completed since G00

| Item                                                                                                                                                                                                              | Owner  | Evidence (command → result, run 2026-10-12)                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `@rea-web/contracts`: route contracts for every application and runner-protocol route (`API_ROUTES`), OpenAPI builder                                                                                             | Fable  | `npx vitest run --project contracts` → 116/116                                                              |
| `@rea-web/db` (WP02): migrations runner, repositories, project-scoped `SKIP LOCKED` claims, fenced heartbeat/transition/complete, lease reaper, `job_events` NOTIFY                                               | Sonnet | `--project db` → 40/40 against local PostgreSQL 16                                                          |
| `@rea-web/storage` (WP02): filesystem and S3 `ObjectStore` with size caps and streamed SHA-256                                                                                                                    | Sonnet | `--project storage` → 103/103 (S3 against an in-process mock; no real S3 service)                           |
| `@rea-web/rea-adapter` (WP05): owned stdio process groups, allowlisted environment, live discovery, Ajv 2020 argument validation, raw + derived results with confidence/authority, evidence ownership per session | Fable  | `--project rea-adapter` → 6/6 against the **real built upstream** MCP server                                |
| `@rea-web/model-connector` (WP07): Anthropic SDK streaming provider with server-side fallbacks; scripted and disabled providers; bounded follow-up loop with redaction, budgets, approvals                        | Fable  | `--project model-connector` → 7/7 (scripted provider only; **no live model call made**: no approved budget) |
| `apps/runner` (WP06): outbound-only claim loop, lease keeper, measured/counted budgets, effect ledger, `investigation.run` and `investigation.follow_up` executors                                                | Fable  | `--project runner` → 11/11 against the real upstream server and a test fake control plane                   |
| `@rea-web/recovery` (WP11): package builder, RECOVERY.md generation, integrity verification, tar pack/unpack with admission limits, Ed25519 signing, chunked AES-256-GCM                                          | Sonnet | `--project recovery` → 62/62                                                                                |
| Deployment definition: Railway IaC (`.railway/railway.ts`, `railway@3.12.0`), API and runner Dockerfiles, local compose stack                                                                                     | Fable  | `npm run deploy:validate` → valid for production and staging (local checks only)                            |

### Active assignments

| WP                                                             | Owner  | Status                                                                                                                                        |
| -------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| WP03/04 API server                                             | Sonnet | Continuing a partial implementation (89 tests written, 88 passing at hand-over). Adding `/api/v1/health`, SSE tests and a secret-logging test |
| WP10 preservation collectors                                   | Sonnet | Started (restart after a rate limit)                                                                                                          |
| WP12 verifier/restorer + recover-cli                           | —      | Not started; depends on WP10 fixture                                                                                                          |
| WP09 frontend                                                  | —      | Not started; depends on WP03/04                                                                                                               |
| Runner executors for preservation/recovery/compare/export jobs | Fable  | Not started; the runner currently refuses these kinds with `capability_unavailable`                                                           |

### Not verified

- Live model provider, real S3, Railway (`railway config plan`), container image builds and the compose stack: no credentials, no Docker daemon. Image base tags are not digest-pinned (Docker Hub returned 429).
- Any provider-backed upstream tool (Ghidra, Hopper, IDA, JADX, …): none installed on this host. See `PARITY-MATRIX.md`.

### Blockers and limitations

- Sub-agents for WP03/04 and WP10 were terminated by a session rate limit (429) and restarted at 23:45 UTC.
- The tag `upstream-baseline-c22111e` could not be pushed (HTTP 403 from the git proxy for tag refs). The baseline is published as branch `upstream-baseline`; the tag exists only locally.

## Checkpoint: G00 complete, G01 contracts started — 2026-10-12

- **Branch / SHA**: `claude/zen-lamport-ijxd7w` (see `git log -1` for the checkpoint SHA); upstream baseline `c22111eca2c4bc84a084f12711f405b3e7422a40` (tag `upstream-baseline-c22111e`, branch `upstream-baseline`).
- **Destination**: `chrismarchant/SaaS-Cloner` was empty (no commits). Upstream history (2,485 commits) was imported with ancestry preserved; no upstream refs are mirror-pushed.

### Completed

| Item                                                                                                                                                                                                                                            | Evidence                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Upstream fetched with full history and tags; pinned                                                                                                                                                                                             | `docs/UPSTREAM-PROVENANCE.md`                                                                                                       |
| Unchanged baseline: install, typecheck, lint, build, artifacts, full deterministic suite                                                                                                                                                        | `docs/verification/G00-baseline.md` (9,229 passed / 2 failed / 123 skipped; one failure is Node-22-only, one reproduces on Node 24) |
| Live runtime discovery (173 tools, 6 prompts, availability groups, digests)                                                                                                                                                                     | `tools/parity-matrix/probes/linux-x64-node22-no-providers.json.gz`                                                                  |
| Parity matrix v0 generated from catalog + live runtime                                                                                                                                                                                          | `docs/PARITY-MATRIX.md` (counts computed, consistency checks pass)                                                                  |
| Upstream env/provider/CI inventories (Haiku, cited)                                                                                                                                                                                             | `docs/inventory/upstream-env-and-providers.md`, `docs/inventory/upstream-ci-lanes-and-checks.md`                                    |
| Code-to-PRD resolved to its pinned MIT source; vendored                                                                                                                                                                                         | `third_party/code-to-prd/`, provenance table                                                                                        |
| Architecture documents                                                                                                                                                                                                                          | `SS00.md`, `ARCHITECTURE.md`, `API.md`, `RECOVERY-FORMAT.md`, `THREAT-MODEL.md`, `IMPLEMENTATION-PLAN.md`                           |
| Workspace scaffold (`rea-web/`, own lockfile) conforming to upstream oxfmt/oxlint with **no upstream file changes**                                                                                                                             | root `npm run check:fast` and `npm run format:check` pass with the extension present                                                |
| `@rea-web/contracts` (G01/WP01): errors, job FSM + budgets, runner protocol + capability digest, SSRF guard, safe paths + archive admission, redaction, API resource schemas, OpenAPI builder, recovery manifest v1, routing table + classifier | 116 tests passing (`npx vitest run --project contracts`)                                                                            |
| Initial PostgreSQL schema                                                                                                                                                                                                                       | `packages/db/migrations/0001_initial.sql` (not yet applied by code)                                                                 |

### Active assignments and ownership

| WP      | Owner  | Status                                                                                                         |
| ------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| WP01    | Fable  | contracts done; `db`/`storage`/`rea-adapter`/`model-connector`/`recovery`/`preservation`/apps are placeholders |
| WP02    | Sonnet | not started (db repositories + storage backends)                                                               |
| WP03/04 | Sonnet | not started (api core, orchestrator)                                                                           |
| WP05    | Fable  | not started (rea-adapter)                                                                                      |

### Verification results summary

- Upstream gate on the unchanged baseline: see G00-baseline.md.
- Extension: `tsc -b` clean; contracts tests 116/116; oxlint warnings only (complexity/max-lines in `ssrf.ts`, `routing.ts`, `openapi.ts`, `resources.ts`); oxfmt clean.
- Not verified: anything involving a live provider, Railway, S3, or a browser.

### Decisions

- D-001…D-008 in `ARCHITECTURE.md`. Added at G00: vendored third-party Markdown/JSON reformatted with upstream oxfmt rather than editing upstream `.oxfmtrc.json` (Python scripts byte-identical, hashes recorded).
- Node: system Node 22.22.0 is inside upstream `engines` but not the `.nvmrc` pin (24.18.0). Node 24.18.0 was fetched (checksum verified) into the scratchpad and used to re-run the failing tests. Extension CI should pin 24 like upstream.

### Blockers and limitations

- Sonnet sub-agent for contract tests was terminated by a session rate limit (`429`, reset 13:10 UTC) after writing `jobs.test.ts`, `runner.test.ts` and the fixture; remaining tests were written by the lead. Sub-agent availability must be re-checked before WP02.
- No Docker daemon, no provider engines, no S3 service in this environment: S3 backend and provider-dependent tools can only be contract-tested here.
- Upstream test `promptCompletion.test.ts › reads live documents …` fails at the pinned revision on both Node versions; recorded, not modified.
- skillvault.md and typingmind.com are unreachable from this network; GitHub sources were used instead.

### Next executable steps

1. WP02: implement `packages/db` (pool, migration runner over `migrations/*.sql`, repositories for users/sessions/tokens/projects/memberships/runners/targets/jobs/leases/events/idempotency) and `packages/storage` (fs + s3 `ObjectStore`), with tests against the local PostgreSQL 16 cluster (`REA_WEB_TEST_DATABASE_URL`).
2. WP05: `packages/rea-adapter` (process ownership, discovery, validated calls, raw+derived, evidence export) tested against the built upstream server.
3. WP03/WP04: `apps/api` auth + routes + orchestrator; serve `/openapi.json` from the route contracts.
4. WP06: `apps/runner` claim loop; end-to-end job round trip; fencing/SSE tests.
5. Prepare Codex review package 1 after the G01 skeleton round-trips a job.
