# Codex review package 2: end-to-end investigation

**Status: prepared, not reviewed.** Record the reviewer, date, reviewed SHA
and findings verbatim from the review session.

## Scope

| Item           | Value                                                                                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewed range | `4359ce2b6..3d4e430a2` on `claude/zen-lamport-ijxd7w`                                                                                                                                                                                              |
| In scope       | `apps/api` (auth, authorization, idempotency, uploads, SSE, runner protocol, job results), `apps/runner/src/investigation/**`, `apps/runner/src/zip.ts`, `apps/web/**`, `packages/db` migrations 0002–0003, `tests/e2e/{investigation,ui}.test.ts` |
| Out of scope   | Preserve & restore (package 3)                                                                                                                                                                                                                     |

## Reproduce

```sh
cd rea-web && npm ci && npx tsc -b tsconfig.json && npm run build -w @rea-web/web
export REA_WEB_TEST_DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:5432/postgres
npx vitest run --project api --project runner --project web
npx vitest run --project e2e tests/e2e/investigation.test.ts tests/e2e/ui.test.ts
```

The browser test needs Chromium; set its path in `tests/e2e/ui.test.ts`.

## Review questions

1. **Authorization.**
   - Can a member of one project read or act on another project's targets, investigations, jobs, evidence, events (SSE), runners or exports?
   - Can a runner act on a job leased to another runner, or read inputs of a job outside its project (`artifact-`, `investigation-`, `raw-`, `capture-file-` inputs)?
2. **CSRF and sessions.**
   - Check the Origin / Sec-Fetch-Site enforcement (`apps/api/src/auth/credentials.ts`), cookie flags and session expiry.
   - Can login or registration be forced cross-site?
3. **Fencing and timeline.**
   - Can a stale runner write events, tool calls, artifacts or completion after reassignment?
   - Is the server-allocated tool-call `seq` (`packages/db/src/repos/investigations.ts`) race-free and idempotent per upstream call?
4. **Session isolation.**
   - Can retained evidence from one investigation be used in another's live session?
   - Comparisons read only stored, digest-checked bundles (`apps/runner/src/investigation/{compare,evidenceSources}.ts`). Is that enforced?
5. **Untrusted content.**
   - Does the UI render any tool output, finding, name or URL as markup or as a live link?
   - Is the CSP effective in production builds?
   - Can an upload name, `X-Target-Name` or an artifact name cause a path or header injection?
6. **Uploads and SSRF.** Check size caps, streaming, cleanup on failure, URL target validation and redirect handling.
7. **Honesty.**
   - Do findings preserve upstream confidence and authority? Facts must come only from observed or derived evidence, and unknowns must be explicit.
   - Does anything claim provider support that was not observed, or present a model result without a model actually running?
8. **Exports.** Does the zip index digest every member? Are redacted members marked? Can member names escape the archive?

## Review record

| Reviewer  | Date | Reviewed SHA | Finding | Severity | Resolution |
| --------- | ---- | ------------ | ------- | -------- | ---------- |
| _pending_ |      |              |         |          |            |
