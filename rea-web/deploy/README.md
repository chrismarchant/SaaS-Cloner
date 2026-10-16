# Deployment

Nothing in this directory deploys anything by itself. It prepares a Railway
project definition, container images and a local compose stack. Creating paid
infrastructure, deploying publicly and setting production secrets are operator
actions.

## What is here

| Path                                  | Purpose                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `../.railway/railway.ts`              | Railway Infrastructure as Code: PostgreSQL, bucket, API service, optional Linux runner  |
| `docker/api.Dockerfile`               | API image; build context `rea-web/`                                                     |
| `docker/runner.Dockerfile`            | Linux runner image with the unchanged upstream REA build; build context repository root |
| `docker/*.Dockerfile.dockerignore`    | Per-Dockerfile ignore files (BuildKit)                                                  |
| `compose/compose.yaml`                | Local disposable stack: PostgreSQL 18, MinIO, API, runner (profile `runner`)            |
| `../tools/deploy/validate-railway.ts` | Local validation of the Railway definition                                              |

Railway's `railway.json`/`railway.toml` (Config as Code) is deprecated and stops
being read on 2026-12-01, so this project uses `.railway/railway.ts`. Its
authoring file lives under `rea-web/` so the upstream tree stays unchanged; run
the Railway CLI from `rea-web/`.

## Validation performed locally

```sh
cd rea-web
npm run deploy:validate
```

This typechecks `.railway/railway.ts` against the pinned `railway@3.12.0`
SDK, evaluates it for `production` and `staging`, and checks that:

- every `REA_WEB_*` name is documented in `docs/API.md#environment`;
- every secret is `preserve()` or a reference, never a literal;
- no literal looks like a credential;
- the runner holds no control-plane credential (database URL, session secret,
  bucket keys);
- each Dockerfile path exists.

It then validates the compose file with `docker compose config`.

### Not verified here (environment-blocked)

| Check                 | Why                                                                                                                                                                                          | How to run                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `railway config plan` | Railway CLI not installed; needs an authenticated, linked project                                                                                                                            | `railway login && railway link && railway config plan` from `rea-web/`               |
| Image builds          | No Docker daemon in the development container                                                                                                                                                | `docker build -f rea-web/deploy/docker/runner.Dockerfile .`                          |
| MinIO image tags      | `minio/minio` and `minio/mc` tags in the compose file could not be resolved from this environment (mirror.gcr.io returned 404; quay.io is blocked here), so they are unverified and unpinned | Confirm a published tag and pin it by `@sha256:` before relying on the compose stack |
| Compose stack run     | No Docker daemon                                                                                                                                                                             | `docker compose -f rea-web/deploy/compose/compose.yaml up --build`                   |

## Pinned images

| Image                                   | Digest (OCI index)                                                        | How it was obtained                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node:24.18.0-bookworm`                 | `sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059` | Fetched from the Docker Hub mirror `mirror.gcr.io` on 2026-10-16; the digest is the SHA-256 of the fetched index bytes; covers linux/amd64, arm64, ppc64le |
| `node:24.18.0-bookworm-slim`            | `sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d` | Same                                                                                                                                                       |
| `postgres:18.0-bookworm` (compose only) | `sha256:3f55f8895c4ed50603e2fbdfc72fffeeaba3173321fee5cb825bbbeb30d9d854` | Same                                                                                                                                                       |

Docker Hub itself rate-limited the lookup (HTTP 429), so the digests were not cross-checked against `registry-1.docker.io`. Re-check them with `docker buildx imagetools inspect node:24.18.0-bookworm` before production.

## Operator steps for Railway

1. Create a Railway project and environment. Install the Railway CLI, then run
   `railway login` and `railway link` from `rea-web/`.
2. Run `railway config plan` and review it. It should create one PostgreSQL
   database, one bucket and two services.
3. Run `railway config apply`.
4. Set the preserved variables in the Railway dashboard, using sealed variables:
   - `rea-web-api`:
     - `REA_WEB_SESSION_SECRET`: at least 32 random bytes.
     - `REA_WEB_PUBLIC_URL`: the public HTTPS origin.
     - `REA_WEB_S3_*`: link these to the bucket's `ENDPOINT`, `REGION`, `BUCKET`, `ACCESS_KEY_ID` and `SECRET_ACCESS_KEY`.
   - `rea-web-runner-linux`:
     - `REA_WEB_RUNNER_TOKEN`: create the runner in the UI first.
     - `REA_WEB_MODEL_PROVIDER`: `disabled` or `anthropic`.
     - `REA_WEB_ANTHROPIC_API_KEY`: only with an approved model budget.
5. In non-production environments, registration is enabled so the first user
   can register and becomes the owner of the default project. Production
   sets `REA_WEB_ALLOW_REGISTRATION=false`. Register the owner in a
   non-production environment, or flip the variable for the first
   registration only.
6. Keep independent copies of recovery exports outside this Railway account,
   for example by downloading them or using another provider's storage. The
   platform being preserved must not be the only place its recovery set lives.

## Runner placement

The Railway runner has Node, git, git-lfs, python3 and `pg_dump` 18. It has no
Docker daemon, GUI, attached devices, macOS or Windows host, and no
privileged execution. Upstream tools that need Ghidra, Hopper, IDA, JADX,
Binwalk/Unblob, pwntools, WABT, Chromium, ADB or macOS utilities stay
unavailable there. The capability panel shows upstream's own reason and
remediation. Run additional self-hosted runners for those capabilities; they
connect outbound to the API with their own runner token. See
`docs/PARITY-MATRIX.md` for per-tool availability on the probed Linux host.
