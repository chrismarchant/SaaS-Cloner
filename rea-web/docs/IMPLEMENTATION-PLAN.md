# Implementation plan and delegation

Model roles follow the master directive: Fable 5.1 owns architecture,
contracts, scaffolding, runtime integration and cross-component decisions;
Sonnet 5.5 implements modules against fixed contracts; Haiku 5.5 performs bounded
inventories, documentation tables and mechanical edits with explicit acceptance
criteria. Opus 5.5 is reserved for operator-initiated secondary sessions. Codex
reviews run in the operator's Devin IDE from the review packages in
`docs/review-packages/`.

## Dependency order

```
contracts ─┬─► db ─► api(core, auth, orchestrator) ─► api(runner protocol) ─► runner(core)
           ├─► storage ──────────────────────────────┘                          │
           ├─► rea-adapter ◄──────────────────────────────────────────────────── runner(investigation)
           ├─► model-connector ◄──────────────────────────────────────────────── runner(follow-up loop)
           ├─► recovery ◄── preservation ◄───────────────────────────────────── runner(preservation, verify)
           │       └─► recover-cli
           └─► web (types only)
```

## Work packages

| WP   | Gate | Scope                                                                                                                                                    | Owner        | Owned paths                                                                                              | Depends on |
| ---- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------- | ---------- |
| WP00 | G00  | Import, pin, baseline, docs, parity matrix generator, probes                                                                                             | Fable        | `rea-web/docs/**`, `rea-web/tools/**`                                                                    | —          |
| WP01 | G01  | Workspace scaffold, tsconfig, vitest, lint conformance, `contracts` (api schemas, errors, job FSM, runner protocol, manifest v1, SSRF guard, safe paths) | Fable        | `rea-web/package.json`, `rea-web/packages/contracts/**`                                                  | —          |
| WP02 | G01  | `db` (pg pool, migrations, repositories) and `storage` (fs + s3)                                                                                         | Sonnet       | `rea-web/packages/db/**`, `rea-web/packages/storage/**`                                                  | WP01       |
| WP03 | G01  | `api` core: auth, projects, memberships, runners, targets, idempotency, OpenAPI serving                                                                  | Sonnet       | `rea-web/apps/api/src/{auth,projects,runners,targets,http}/**`                                           | WP02       |
| WP04 | G01  | `api` orchestrator: queue, leases, fencing, reaper, events, SSE, budgets, approvals, runner protocol                                                     | Sonnet       | `rea-web/apps/api/src/{orchestrator,jobs,runner-protocol}/**`                                            | WP03       |
| WP05 | G01  | `rea-adapter`: process ownership, discovery, validation, raw+derived, evidence export, session map                                                       | Fable        | `rea-web/packages/rea-adapter/**`                                                                        | WP01       |
| WP06 | G01  | `runner` core: registration, claim loop, heartbeat, workspace, budgets, cancellation, cleanup                                                            | Fable        | `rea-web/apps/runner/src/{core,workspace,budget}/**`                                                     | WP04, WP05 |
| WP07 | G02  | Investigation execution: routing table, deterministic pass, findings, obligations, export                                                                | Sonnet       | `rea-web/apps/runner/src/investigation/**`                                                               | WP06       |
| WP08 | G02  | `model-connector` + follow-up loop                                                                                                                       | Sonnet       | `rea-web/packages/model-connector/**`, `rea-web/apps/runner/src/followup/**`                             | WP07       |
| WP09 | G02  | `web`: targets, capability panel, timeline, evidence detail, feature view, comparison, export, advanced tool forms                                       | Sonnet       | `rea-web/apps/web/**`                                                                                    | WP03, WP04 |
| WP10 | G03  | `preservation` collectors: git, dependencies, pg, assets, infrastructure, integrations, product (Code-to-PRD)                                            | Sonnet       | `rea-web/packages/preservation/**`, `rea-web/apps/runner/src/preservation/**`                            | WP06       |
| WP11 | G03  | `recovery`: manifest, packer, hashing, RECOVERY.md, signing, encryption                                                                                  | Sonnet       | `rea-web/packages/recovery/src/{manifest,pack,crypto}/**`                                                | WP01       |
| WP12 | G04  | `recovery` verifier/restorer + `recover-cli` bundle + clean-restore fixture                                                                              | Sonnet       | `rea-web/packages/recovery/src/verify/**`, `rea-web/apps/recover-cli/**`, `rea-web/fixtures/recovery/**` | WP11       |
| WP13 | G04  | Runtime validation of restore isolation (network deny, disposable pg)                                                                                    | Fable        | `rea-web/apps/runner/src/verify/**`                                                                      | WP12       |
| WP14 | G05  | Local companion runner packaging, host routing matrix, macOS/Windows notes                                                                               | Fable/Sonnet | `rea-web/apps/runner/**`, `rea-web/docs/PARITY-MATRIX.md`                                                | WP06       |
| WP15 | G06  | Platform collectors (Railway/Supabase), retention, scheduling, deployment hardening                                                                      | Sonnet       | `rea-web/deploy/**`, `rea-web/packages/preservation/src/platform/**`                                     | WP10       |
| WPH1 | all  | Inventories: env var names, CI lanes, provider/host tables, doc consistency                                                                              | Haiku        | `rea-web/docs/inventory/**`                                                                              | —          |

Shared files with a single owner (no concurrent edits): `rea-web/package.json`,
`rea-web/package-lock.json`, `rea-web/tsconfig.base.json`,
`rea-web/vitest.workspace.ts`, everything under `packages/contracts/`, all SQL
migrations under `packages/db/migrations/`. Owner: Fable. Agents request
contract changes in their completion report; they do not edit these files.

## Delegation template

Every assignment states: objective; specification sections (SS00 §, API.md
tables, RECOVERY-FORMAT.md); required contracts (exact exported names from
`contracts`); owned files/directories; dependencies and prohibited changes
(upstream files, shared files, other agents' directories); acceptance checks
(exact commands and expected results); completion report format (changed files,
implemented behaviour, checks run with actual output, unresolved issues,
decisions needed).

Concurrency: at most two implementation agents at once; dependent packages are
sequential; disjoint packages may run in parallel.

## Acceptance evidence mapping (directive §17)

| Evidence                                                   | Where produced                                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Unchanged upstream baseline + final regression             | `docs/verification/G00-baseline.md`, re-run at each gate                      |
| Catalog/schema parity against pinned runtime               | `tools/parity-matrix` compares catalog JSON, live `tools/list`, runner report |
| Explicit unavailable reasons                               | capability panel renders runner `reason`/`remediation`; API `/routing`        |
| Isolation between concurrent investigations                | runner test: two sessions, cross-ref rejected                                 |
| Ownership of stateful follow-ups                           | `follow-ups` route to owning session; `session_closed` otherwise              |
| Real fixture analysis + export through UI                  | Playwright e2e over `fixtures/investigation/*`                                |
| Durable recovery after worker termination                  | orchestrator test: kill runner mid-job → interrupted → requeue                |
| Fencing, idempotency, SSE reconnect                        | API tests                                                                     |
| Authorization rejections                                   | API tests across roles and projects                                           |
| Traversal/symlink/archive/SSRF rejection                   | `fixtures/security/*` tests                                                   |
| Secrets excluded from logs/model inputs                    | `fixtures/security/secrets-fixture` assertions                                |
| Clean restoration from recovery set only                   | `recover-cli` test in an empty temp dir with network denied                   |
| Build/data/behaviour checks                                | verifier scopes                                                               |
| Partial/blocked outcomes for corrupt/missing components    | tampered fixtures                                                             |
| Production call/schedule/webhook prevention during restore | `restore_guards.json` tests                                                   |
| Process cleanup and resource limits                        | runner budget/cleanup tests                                                   |
| Evidence after session teardown                            | exported bundle present after process exit                                    |
| Railway configuration validated locally                    | `deploy/` schema validation + local compose run                               |
