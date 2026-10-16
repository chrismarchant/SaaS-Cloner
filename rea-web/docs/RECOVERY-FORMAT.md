# Portable recovery format v1

A recovery package is a directory (or its tar export) that a standalone
verifier/restorer can consume without the control plane, its database, or the
original project filesystem. The JSON Schema for `manifest.json` is the source
of truth and lives at `rea-web/packages/contracts/src/recovery/manifest.v1.schema.json`
(generated from the zod definition in `manifest.ts`); a copy is embedded in every
package at `recovery/manifest.v1.schema.json`.

## Layout

```
manifest.json                 required; see schema
RECOVERY.md                   human-readable restore guide generated from the manifest
source/                       git bundles, working-tree deltas, submodule bundles, LFS payloads
data/                         database dumps (pg custom format), globals, schema-only dump, invariants
assets/                       object payloads + per-bucket manifest (path, size, sha256, content-type, mtime)
infrastructure/               services.json, env-names.json, domains.json, schedules.json, health.json, images.json
product/                      PRD output (Code-to-PRD), route/field/permission/state/job/enum inventories, REA evidence refs
artifacts/                    shipped-artifact evidence from REA (evidence bundles, raw results) when configured
recovery/                     restore scripts (sh + ps1), verifier bundle (rea-recover.mjs), manifest schema, restore_guards.json
verification/                 verifier reports produced at capture time and at later runs
licenses/                     third-party notices for anything redistributed in the package
```

## manifest.json (v1) — required top-level fields

| Field                  | Type      | Meaning                                                                                                                                                                                |
| ---------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`               | const     | `"rea-web-recovery"`                                                                                                                                                                   |
| `format_version`       | const     | `1`                                                                                                                                                                                    |
| `package_id`           | string    | UUID of this package                                                                                                                                                                   |
| `build`                | object    | `{ id, name, project_slug, description }` — build identity                                                                                                                             |
| `created_at`           | date-time | manifest creation time (UTC)                                                                                                                                                           |
| `producer`             | object    | `{ name: "rea-web", version, upstream_rea: { package_version, source_sha, catalog_digest } , tools: [{name, version}] }`                                                               |
| `source_revisions`     | array     | `[{ repository, remote_url_redacted, head_sha, refs: [{name, sha}], submodules: [{path, sha, url}], lfs: {count, bytes, included} , working_tree: {included, dirty_files} }]`          |
| `components`           | array     | one entry per captured component (see below)                                                                                                                                           |
| `relationships`        | array     | `[{ from: component_id, to: component_id, kind: "depends_on"                                                                                                                           | "serves"                                                                                             | "backs"                           | "generated_from" }]` |
| `files`                | array     | every file in the package except `manifest.json`: `{ path, size, sha256, component_id, media_type? }`                                                                                  |
| `dependencies`         | object    | `{ runtimes: [{name, version, source}], package_managers: [...], container_images: [{ref, digest}], registries: [{url, required_for, credentials_required}], system_packages: [...] }` |
| `manual_prerequisites` | array     | `[{ id, title, reason, instructions, component_id? }]` — things a restorer must do by hand (accounts, OAuth apps, DNS)                                                                 |
| `secrets`              | object    | `{ mode: "names_only"                                                                                                                                                                  | "escrow", names: [...], escrow_ref?: path, escrow_encryption?: {...} }`— never values in`names_only` |
| `consistency`          | object    | `{ strategy, window: {start, end}, classification: "single_point"                                                                                                                      | "inconsistent"                                                                                       | "unknown", gaps: [...] }`         |
| `verification`         | object    | `{ scope: [...], results: [{ scope, status, detail, performed_at, evidence_path? }], network_required: {verdict: "yes"                                                                 | "no"                                                                                                 | "unknown", reasons: [...] } }`    |
| `missing_or_blocked`   | array     | `[{ component_id, status: "missing"                                                                                                                                                    | "blocked"                                                                                            | "manual", reason, remediation }]` |
| `signature`            | object?   | `{ algorithm: "ed25519", public_key_id, detached_path: "manifest.json.sig" }` — optional                                                                                               |
| `encryption`           | object?   | `{ scheme: "age-x25519"                                                                                                                                                                | "aes-256-gcm-envelope", recipients: [key_ids], key_location: "external" }` — never key material      |

### Component entry

```
{
  "id": "source:main", "kind": "source" | "dependencies" | "data" | "assets" | "infrastructure" | "integrations" | "product" | "artifacts",
  "title": "...",
  "status": "captured" | "partial" | "blocked" | "manual",
  "captured_at": { "start": "...", "end": "..." },
  "method": "git bundle --all" | "pg_dump -Fc" | "s3 list+get" | ...,
  "root": "source/main/",
  "entries": 1234, "bytes": 123456789,
  "restore": { "steps": [ { "id": "...", "run": ["git","clone","source/main/repo.bundle","{{target}}"], "cwd": "...", "requires": ["git>=2.30"] } ] },
  "limitations": [ "..." ],
  "omissions": [ { "what": "...", "reason": "...", "remediation": "..." } ]
}
```

Restore `run` values are argument arrays, never shell strings. `{{target}}`,
`{{database_url}}`, `{{assets_root}}` and `{{package_root}}` are the only
template placeholders and are supplied by the restorer. A step may not start a
shell interpreter (matched by program basename) or a launcher that runs
another program (`env`, `xargs`, `timeout`, …), and its `cwd` must lie under
`{{target}}`, `{{package_root}}` or `{{assets_root}}`.

Each step declares the outbound network it needs: `none`, `database` (only the
disposable database the restorer supplies), `registry` (package registries) or
`unknown`. The restorer denies all other outbound network where the host
allows it (a Linux network namespace) and records in its report whether
isolation was enforced. The password of `{{database_url}}` is passed to child
processes through `PGPASSWORD`, never on the command line.

Verifier reports (`rea-web-recovery-report`, schema in
`packages/contracts/src/recovery/report.ts`) are written outside the package:
a finalized package is immutable.

## Verification status vocabulary

| Status                  | Meaning                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `captured`              | Bytes exist in the package with recorded hashes.                                                            |
| `integrity_verified`    | Every file's SHA-256 matched and the manifest validated against the embedded schema.                        |
| `clean_build_verified`  | Source restored into an empty directory, dependencies installed, and the declared build command succeeded.  |
| `data_restore_verified` | Database restored into a disposable instance and declared invariants (row counts, checksums, queries) held. |
| `behavior_verified`     | Named critical behaviour checks (HTTP probes, CLI invocations, screenshot comparisons) passed.              |
| `partial`               | Some scopes passed, some did not; details per scope.                                                        |
| `blocked`               | A scope could not run (missing prerequisite, network required but denied, unsupported host).                |
| `failed`                | A scope ran and its checks did not pass (a step exited non-zero, an invariant did not hold).                |

No percentage is ever derived from these statuses. The verifier reports
`network_required.verdict` from observed restore steps: `no` only when every
step completed with outbound network denied.

## Security rules

- `secrets.mode = names_only` is the default; values never appear anywhere in
  the package, including logs copied into `verification/`.
- Optional escrow writes a separately encrypted file; the manifest records only
  the recipient key IDs and the location of the recovery key _outside_ the
  package.
- Encryption of the whole export never stores its key inside the export.
- Restore defaults: disposable target directories, disposable database,
  `restore_guards.json` listing blocked production hosts, disabled schedules
  and webhook endpoints that the restorer must leave disabled unless explicitly
  overridden with `--allow-production` (refused by the verifier mode).

## Export signatures

A finalized manifest is immutable, so a signature requested when an export
is created cannot be added to the manifest. Instead it is a detached
document over the export archive exactly as distributed, after any
encryption:

```json
{
  "format": "rea-web-export-signature",
  "version": 1,
  "algorithm": "ed25519",
  "public_key_id": "<sha256 of the DER SPKI public key>",
  "archive_sha256": "<sha256 of the archive file>",
  "signed_at": "…",
  "signature": "<base64 Ed25519 over 'rea-web-export-signature:v1\n' + archive_sha256>"
}
```

The signing key stays on the runner (`REA_WEB_EXPORT_SIGNING_KEYS_DIR`,
`<public key id>.pem`). The command
`rea-recover verify|restore|unpack <archive> --archive-signature <file> --archive-key <public.pem>`
checks the signature before anything is unpacked, and exits 3 if it does
not verify. A manifest-level signature (`signature` in the manifest, checked
with `--public-key`) is declared at capture time.

## Independence requirements

- `recovery/rea-recover.mjs` is a self-contained Node 22 bundle with no
  dependency on the control plane. It implements `verify` (integrity + schema
  - status report) and `restore` (executes component steps into disposable
    targets, records per-scope results).
- Required external tools are declared in `dependencies.runtimes` and
  `component.restore.steps[].requires` (e.g. `git`, `pg_restore`, `node`,
  `npm`). The verifier checks their presence first and reports `blocked` with
  the missing tool instead of attempting a partial restore.
- Keep at least one copy of each export outside the primary platform/account
  failure domain; the export screen records where copies were placed
  (`verification/copies.json`) as declared by the operator, not as proof.
