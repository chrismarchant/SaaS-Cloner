# Codex review package 3: end-to-end recovery

**Status: prepared, not reviewed.** No review result exists yet. Record the
reviewer, date, reviewed SHA and findings verbatim from the review session.

## Scope

| Item           | Value                                                                                                                                                                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewed range | `4359ce2b6..61032ba8e` on `claude/zen-lamport-ijxd7w`                                                                                                                                                                                                                                                             |
| In scope       | `packages/preservation`, `packages/recovery` (including `src/verify/`), `apps/recover-cli`, `apps/runner/src/{preservation,recovery}`, the API build/plan/capture/verification/export routes and input serving, `packages/contracts/src/{recovery,api/resources.ts}`, `tests/e2e/{preservation,recovery}.test.ts` |
| Out of scope   | Web UI (in progress), investigation workflow (package 2)                                                                                                                                                                                                                                                          |

## Reproduce

```sh
cd rea-web && npm ci && npx tsc -b tsconfig.json && npm run build -w @rea-web/recover-cli
export REA_WEB_TEST_DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:5432/postgres
npx vitest run --project preservation --project recovery --project recover-cli
npx vitest run --project e2e tests/e2e/preservation.test.ts tests/e2e/recovery.test.ts
```

The e2e tests need the upstream build (`npm run build:cached` at the root),
git, git-lfs, python3 and the PostgreSQL client tools. Network isolation
assertions need `unshare -rn` to work on the host.

## Review questions

1. **Secrets.**
   - Can any capture credential, database password, git credential or `.env` value reach a package file, the manifest, a job result, a log line, a restore report or an export archive?
   - Trace `connection_env_name` from the runner environment to `pg_dump`, then to `pg_restore` during verification.
2. **Host boundary.**
   - Can a build definition make a runner read a host path outside `REA_WEB_RUNNER_LOCAL_TARGET_ALLOWLIST`? Consider `git` sources (`apps/runner/src/preservation/execute.ts`), `runner_local` path hashes and asset sources.
   - Can a git URL reach internal hosts, given DNS rebinding between the check and git's own resolution?
3. **Restore isolation.**
   - Restore steps are argument arrays validated by `validateRestoreStepArguments`. Look for ways to execute arbitrary code beyond the declared programs, for example `git -c` options, `npm` lifecycle scripts or `pg_restore` options.
   - Check `cwd` confinement and symlinks inside the package or target (`packages/recovery/src/verify/stepRunner.ts`).
4. **Network verdict.** Is `network_required.verdict = "no"` ever reported when a step actually had network access? Check the database-over-TCP and registry paths.
5. **Disposability.** Is it possible to restore into a non-empty or production database, or into a non-empty or package-internal target? Is the runner's scratch database always dropped, including on abort and lease loss?
6. **Integrity.**
   - Are the digest checks complete: every `files[]` entry, the derived files, the extra-file detection and the signature?
   - Can a stored object be swapped between capture and verify/export without detection?
   - Check `capture-file-<n>` serving in `apps/api/src/routes/runnerProtocol.ts`.
7. **Encryption.** Can the key be placed inside the archive or package? Is nonce/AAD handling sound against chunk reordering and truncation (`packages/recovery/src/encryption.ts`)?
8. **Consistency.** Is `single_point` claimed only when data and assets fall in one window and invariants were stable?
9. **Honesty.** Do the restore report, RECOVERY.md and UI-facing results ever claim more than was verified? Look for overall statuses, the verdict, and the Code-to-PRD disclaimers.

## Review record

| Reviewer  | Date | Reviewed SHA | Finding | Severity | Resolution |
| --------- | ---- | ------------ | ------- | -------- | ---------- |
| _pending_ |      |              |         |          |            |
