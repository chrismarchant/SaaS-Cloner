# Codex review package 4: final integration

**Status: prepared, not reviewed.** Record the reviewer, date, reviewed SHA
and findings verbatim from the review session.

## Scope

| Item           | Value                                                                                                                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewed range | `upstream-baseline..HEAD` on `claude/zen-lamport-ijxd7w` (the head containing `docs/FINAL-REPORT.md`)                                                                                                                                                                  |
| Focus          | Changes since package 3: G05 (companion runner, local targets, host routing), G06 (S3/Supabase Storage assets, platform-config collectors, export signing, image pinning), the Preserve & restore UI and its API routes, and the claims made in `docs/FINAL-REPORT.md` |

## Reproduce

Follow `docs/FINAL-REPORT.md`, sections "Quick start" and "Test evidence". All six e2e suites need PostgreSQL, the upstream build, git, git-lfs, python3, the PostgreSQL client tools and Chromium.

## Review questions

1. **Report honesty.** Does every claim in `docs/FINAL-REPORT.md` trace to a test, document or command result? Is anything claimed for an unprobed host, a provider that was not installed, a model, real S3 or Supabase, Railway, or a container build?
2. **Local paths.**
   - Can the browser, API or a build definition make a runner read a host path outside its allowlist? Check the `runner_local` targets, investigations, preservation sources, assets and `git` sources.
   - Can a path leak to the control plane through target views, tool results or logs? Note that upstream raw results of tools run on a local path contain that path by design. Decide whether that is acceptable.
3. **S3 and Supabase.**
   - Check the SSRF handling for declared endpoints, including pinned DNS.
   - Can credentials reach a file, log or result?
   - Is truncation always visible? The limits make the capture `partial`.
4. **Platform config.**
   - Are the parsers fail-closed?
   - Can a hostile config file inject a restore step that runs arbitrary code? Look at shell-syntax detection, the tokenizer and `validateRestoreStepArguments`.
   - Are assignment values kept out of recorded text?
5. **Export signing.**
   - Is the signed message unambiguous?
   - Is the signature checked before any decryption or unpacking?
   - Can a signing key file be substituted, given that the file name must match the key id?
6. **API.**
   - Do the new list, report and signature routes enforce project membership?
   - Do they serve only objects under the resource's own storage prefix?
7. **Contracts.** Is every value that crosses the API/runner/UI boundary parsed with a schema from `@rea-web/contracts`? List any place that still reinterprets raw data.

## Review record

| Reviewer  | Date | Reviewed SHA | Finding | Severity | Resolution |
| --------- | ---- | ------------ | ------- | -------- | ---------- |
| _pending_ |      |              |         |          |            |
