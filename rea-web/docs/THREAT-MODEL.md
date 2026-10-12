# Threat model

## Assets

- Control-plane credentials (database, object store, model provider API key,
  session secret).
- Project data: targets, evidence, findings, recovery packages (which may
  contain the operator's full source, database dumps and assets).
- Runner hosts and whatever runner-local applications they can reach.
- Integrity of findings (no fabricated or silently altered evidence).

## Trust boundaries

| Boundary                    | Trusted side             | Untrusted side                                                                |
| --------------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| Browser → API               | API                      | Any HTTP client; cookies/tokens may be stolen; inputs hostile                 |
| API → Runner                | API issues jobs          | Runner results are data; a compromised runner can lie about its own jobs only |
| Runner → target             | Runner process           | Target bytes, extracted text, archives, websites, third-party skills          |
| Runner → upstream REA       | Adapter validates inputs | REA outputs are data; REA may launch provider processes (documented effects)  |
| Runner → model provider     | Connector                | Model outputs are untrusted proposals; validated before any execution         |
| Package → verifier/restorer | Verifier                 | Package contents may be corrupted or malicious                                |

Repository content, extracted text, target files, model output and third-party
skill text cannot change job policy, budgets, credentials, or approval
decisions. Only authenticated users with a sufficient role can.

## Threats and controls

| ID   | Threat                                                          | Control                                                                                                                                                                                           | Verified by                                                                                     |
| ---- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| T-01 | Cross-project access to targets/jobs/artifacts/runners/streams  | Membership check in every handler via `authorizeProject(role)`; IDs are looked up with `project_id` in the predicate; SSE streams authorize before subscribing                                    | `apps/api/test/authorization.test.ts`                                                           |
| T-02 | Path traversal / symlink escape in uploads, extraction, restore | Uploads stored under server-derived keys only; extraction uses a `safeExtract` that rejects `..`, absolute paths, symlinks/hardlinks, and names outside the root after `realpath`                 | `packages/storage` and `packages/recovery` tests with hostile fixtures                          |
| T-03 | Archive bombs                                                   | Limits on entry count, per-entry size, total expanded bytes, expansion ratio; streaming decompression aborted on breach                                                                           | fixture `fixtures/security/zip-bomb-*.zip`                                                      |
| T-04 | Oversized inputs                                                | Content-length and streamed byte caps per endpoint; budgets per job                                                                                                                               | API tests                                                                                       |
| T-05 | SSRF via URL targets, webhooks, OAuth callbacks                 | Scheme allowlist; DNS resolve → reject private/loopback/link-local/multicast/CGNAT; connect to the resolved IP with `Host` header pinned (prevents rebinding); redirects re-validated; max 3 hops | `packages/contracts/src/net/ssrf.test.ts`                                                       |
| T-06 | Shell injection in collectors/adapters                          | `child_process.spawn` with argument arrays only; no `shell: true`; lint rule forbids `exec`/`execSync`                                                                                            | oxlint `no-restricted-imports` in rea-web config + tests                                        |
| T-07 | Secret leakage to logs, archives, model inputs                  | Structured logger with redaction of known secret names, `Authorization`, cookies, bearer patterns; exports default to names-only; redaction pass before model submission                          | `fixtures/security/secrets-fixture` test asserts absence in logs, exports, model request bodies |
| T-08 | Stale runner completing a reassigned job                        | Fencing token compared in the same transaction; lease expiry enforced                                                                                                                             | orchestrator tests                                                                              |
| T-09 | Replay of mutating requests                                     | Idempotency keys with request hash                                                                                                                                                                | API tests                                                                                       |
| T-10 | Runner exposes CDP/ADB/MCP to the internet                      | Runner has no inbound listener; MCP is stdio only; CDP/ADB stay loopback per upstream                                                                                                             | runner code review + no `listen()` in runner                                                    |
| T-11 | Model-proposed destructive or foreign-code execution            | Effects from the live catalog; default approval set; `awaiting_approval` state; approver role ≥ member                                                                                            | policy tests                                                                                    |
| T-12 | Cross-investigation evidence leakage                            | One REA process per investigation; `evidence_id → session` map; cross-session refs rejected                                                                                                       | isolation test with two concurrent investigations                                               |
| T-13 | Restore hitting production                                      | `restore_guards.json`; verifier denies outbound by default; production hostnames blocklisted; schedules/webhooks recorded as disabled                                                             | recovery tests                                                                                  |
| T-14 | Encryption key stored with the archive                          | Key location recorded as `external`; packer refuses to write key material under the package root                                                                                                  | recovery tests                                                                                  |
| T-15 | Hostile package fed to verifier/restorer                        | Schema validation first; hash verification before any step; steps are argument arrays with placeholders only; no `shell`                                                                          | recovery tests with tampered fixtures                                                           |
| T-16 | Resource exhaustion by a target (fork bombs, huge output)       | Process groups, `prlimit` where available, wall/cpu/memory/disk budgets, output caps, kill on cancel                                                                                              | runner budget tests                                                                             |
| T-17 | Credential sprawl between capture and restore                   | Separate capture and restore credentials by convention (`REA_WEB_CAPTURE_*` vs restorer-supplied); never both in one environment                                                                  | documentation + env name inventory                                                              |

## Residual risks

- A compromised runner host can falsify results for jobs leased to it; the
  capability report is self-attested. Mitigation: runner tokens are
  project-scoped and revocable; results carry the runner ID.
- Self-hosted runners that mount GUI/device capabilities inherit the host's
  security posture; upstream's own effect documentation governs those tools.
- Model providers see redacted derived summaries; redaction is name/pattern
  based and cannot prove no secret-like text escapes. Fixture tests cover known
  secret names only.
