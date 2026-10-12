# Progress

Updated at each gate checkpoint. Newest first.

## Checkpoint: G00 complete, G01 contracts started — 2026-10-12

- **Branch / SHA**: `claude/zen-lamport-ijxd7w` (see `git log -1` for the checkpoint SHA); upstream baseline `c22111eca2c4bc84a084f12711f405b3e7422a40` (tag `upstream-baseline-c22111e`, branch `upstream-baseline`).
- **Destination**: `chrismarchant/SaaS-Cloner` was empty (no commits). Upstream history (2,485 commits) was imported with ancestry preserved; no upstream refs are mirror-pushed.

### Completed

| Item                                                   | Evidence                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| Upstream fetched with full history and tags; pinned    | `docs/UPSTREAM-PROVENANCE.md`                                            |
| Unchanged baseline: install, typecheck, lint, build, artifacts, full deterministic suite | `docs/verification/G00-baseline.md` (9,229 passed / 2 failed / 123 skipped; one failure is Node-22-only, one reproduces on Node 24) |
| Live runtime discovery (173 tools, 6 prompts, availability groups, digests) | `tools/parity-matrix/probes/linux-x64-node22-no-providers.json.gz`        |
| Parity matrix v0 generated from catalog + live runtime | `docs/PARITY-MATRIX.md` (counts computed, consistency checks pass)        |
| Upstream env/provider/CI inventories (Haiku, cited)    | `docs/inventory/upstream-env-and-providers.md`, `docs/inventory/upstream-ci-lanes-and-checks.md` |
| Code-to-PRD resolved to its pinned MIT source; vendored | `third_party/code-to-prd/`, provenance table                              |
| Architecture documents                                  | `SS00.md`, `ARCHITECTURE.md`, `API.md`, `RECOVERY-FORMAT.md`, `THREAT-MODEL.md`, `IMPLEMENTATION-PLAN.md` |
| Workspace scaffold (`rea-web/`, own lockfile) conforming to upstream oxfmt/oxlint with **no upstream file changes** | root `npm run check:fast` and `npm run format:check` pass with the extension present |
| `@rea-web/contracts` (G01/WP01): errors, job FSM + budgets, runner protocol + capability digest, SSRF guard, safe paths + archive admission, redaction, API resource schemas, OpenAPI builder, recovery manifest v1, routing table + classifier | 116 tests passing (`npx vitest run --project contracts`) |
| Initial PostgreSQL schema                                | `packages/db/migrations/0001_initial.sql` (not yet applied by code)        |

### Active assignments and ownership

| WP   | Owner  | Status                                                                                  |
| ---- | ------ | --------------------------------------------------------------------------------------- |
| WP01 | Fable  | contracts done; `db`/`storage`/`rea-adapter`/`model-connector`/`recovery`/`preservation`/apps are placeholders |
| WP02 | Sonnet | not started (db repositories + storage backends)                                         |
| WP03/04 | Sonnet | not started (api core, orchestrator)                                                  |
| WP05 | Fable  | not started (rea-adapter)                                                               |

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
