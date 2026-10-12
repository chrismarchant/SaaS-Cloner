# Codex review package 1: baseline and architecture

**Status: prepared, not reviewed.** No review result exists yet. Record the
reviewer, date, reviewed SHA and findings in the table at the end, verbatim from the
review session. Do not summarise a review that did not happen.

## Scope

| Item           | Value                                                                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository     | `chrismarchant/SaaS-Cloner`, branch `claude/zen-lamport-ijxd7w`                                                                                                                                     |
| Reviewed range | `upstream-baseline..4359ce2b6`                                                                                                                                                                      |
| Upstream pin   | `morluto/rea@c22111eca2c4bc84a084f12711f405b3e7422a40` (`rea-agents@6.4.0`)                                                                                                                         |
| In scope       | G00 import and baseline; architecture documents; the G01 control-plane components already committed (contracts, db, storage, rea-adapter, model-connector, runner, recovery, deployment definition) |
| Out of scope   | `rea-web/apps/api` (still in progress, uncommitted at preparation time), preservation collectors, verifier/restorer, frontend                                                                       |

## How to reproduce the local evidence

```sh
git fetch origin claude/zen-lamport-ijxd7w upstream-baseline
git checkout 4359ce2b6
# 1. Upstream is unchanged
git diff --stat upstream-baseline...HEAD -- . ':(exclude)rea-web'    # expect no output
# 2. Upstream gate (pinned toolchain from .nvmrc)
npm ci && npm run check:fast
# 3. Extension
cd rea-web && npm ci && npx tsc -b tsconfig.json
REA_WEB_TEST_DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:5432/postgres \
  npx vitest run --project contracts --project db --project storage \
  --project recovery --project model-connector --project rea-adapter --project runner
npm run deploy:validate
```

`rea-adapter` and `runner` tests start the real upstream MCP server, so they
need the upstream build (`npm run build:cached` at the repository root) first.
`db` tests need a PostgreSQL role that can create databases.

Expected counts at this SHA, from the preparer's run: contracts 116, db 40,
storage 103, recovery 62, model-connector 7, rea-adapter 6, runner 11. All
passed. Upstream baseline results, including two pre-existing upstream
failures, are in `docs/verification/G00-baseline.md`.

## Review questions

Answer each one with a file and line reference, or say that it is not an issue.

### Baseline and provenance

1. Does `docs/UPSTREAM-PROVENANCE.md` let a third party re-derive the import (SHA, history, tags), and is the claim "no upstream file changed" true for every commit in range, not only the tip?
2. Are the two baseline failures in `G00-baseline.md` correctly attributed to upstream rather than to the environment?
3. Is the vendored Code-to-PRD (`third_party/code-to-prd/`) faithful to its pinned source, and is every downstream change (formatting of Markdown/JSON) disclosed in `DOWNSTREAM-CHANGES.md`? Are the Python scripts byte-identical?

### Architecture and contracts

4. `docs/SS00.md` §6: is the job state machine in `packages/contracts/src/jobs.ts` complete? Can any state be stuck: no outgoing transition and not terminal? Is there a transition a runner should not be able to make?
5. Fencing: do `packages/db/src/repos/jobs.ts` claim/heartbeat/transition/complete reject every write from a stale lease, including in concurrent transactions? Is `reapExpiredLeases` safe to run from several API replicas at once?
6. Effect ledger: can the runner (`apps/runner/src/jobContext.ts`, `investigation/execute.ts`) re-run a non-repeatable effect after a lease expiry?
7. Budgets: counted budgets stop with `partial`; measured budgets fail with `budget_exceeded`. Is that consistent between `SS00.md` §6, `contracts/src/jobs.ts` and `apps/runner/src/budget.ts`?
8. Capability report: does `contracts/src/runner.ts` (`digestCapabilities`, `unmetRequirements`) derive availability only from upstream's live `binary_session` data, never from a static list?

### Security (THREAT-MODEL.md)

9. `contracts/src/net/ssrf.ts`: are there bypasses? Consider IPv4-mapped IPv6, decimal/octal hosts, trailing dots, IDNA, redirects and DNS rebinding (T-04).
10. `contracts/src/fs/safePath.ts` and `packages/recovery` archive unpacking: path traversal, symlink and hard-link escapes, absolute names, and archive-bomb limits (T-05, T-06).
11. `packages/rea-adapter/src/environment.ts` and `ownedProcess.ts`: can a control-plane credential reach the upstream child process? Is the whole process group killed on every exit path?
12. `contracts/src/redaction.ts` and its uses: is anything stored or logged unredacted? This covers tool stdout/stderr, model prompts, findings and errors.
13. `packages/recovery` crypto: is the AES-256-GCM chunk nonce/AAD construction safe against chunk reordering, truncation and extension? Does the key ever get written inside the package it protects?
14. `.railway/railway.ts` and `deploy/`: does the runner service hold any control-plane credential? Is any secret a literal? Is anything exposed publicly that should only be on the private network?

### Honesty of claims

15. Does any document, test name or comment claim support or parity that the evidence does not show? Look especially for live-provider claims made from mocked tests, completeness percentages, and "rebuildable" claims.

## Review record

| Reviewer  | Date | Reviewed SHA | Finding | Severity | Resolution |
| --------- | ---- | ------------ | ------- | -------- | ---------- |
| _pending_ |      |              |         |          |            |
