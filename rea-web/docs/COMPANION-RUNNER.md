# Local companion runner

A companion runner is the same `apps/runner` process, run on a machine you
control. It is useful when that machine has something the cloud runner
lacks: a provider (Ghidra, Hopper, IDA, JADX, Binwalk/Unblob, WABT,
Chromium, ADB), a macOS or Windows host, attached devices, or files you
don't want to upload.

The companion only connects outbound to the API, over HTTPS, using its own
runner token. It opens no listening port and exposes no CDP, ADB, shell or MCP
endpoint.

## What was verified, and what was not

`tests/e2e/companion.test.ts` verifies the following on Linux. It runs a
cloud runner and a companion runner side by side against the built API:

- The companion's allowlisted directory appears as a `runner_local` target.
  The listing shows only its name, class and `path_hash`, never the path.
- An investigation of that target runs on the companion, and only there.
  The companion resolves the path from its own allowlist; nothing is
  uploaded.

macOS and Windows hosts have not been run here.

- On POSIX hosts the runner owns each REA process as a process group and
  terminates the whole group.
- On Windows there are no process groups. The adapter terminates only the
  direct REA child, and its cleanup report records `group: false`. A
  provider process that REA started can therefore outlive cancellation.

Treat Windows as unverified until it is probed (see below).

## Install

The runner drives the upstream REA build that sits next to it in the
repository.

```sh
git clone <this repository> rea && cd rea
nvm use                      # Node 24.18.0 per .nvmrc
npm ci && npm run build:cached           # upstream REA, unchanged
cd rea-web && npm ci && npx tsc -b tsconfig.json
npm run build -w @rea-web/recover-cli    # optional: embed rea-recover in captures
```

Install any providers you want this host to offer, following upstream's
setup guides (`README.md#choosing-a-deep-analysis-provider`). REA reads
provider settings from its own `REA_*` variables. The runner passes those to
REA only when you list them in `REA_WEB_REA_PASSTHROUGH_ENV`, and passes no
other part of its environment.

## Register and run

1. In the web UI, open **Runners → New runner**. Give it a name and labels
   (for example `local`, `macos`). Copy the token; it is shown once.
2. Start the runner:

```sh
export REA_WEB_API_URL=https://<your control plane>
export REA_WEB_RUNNER_TOKEN=<token from step 1>
export REA_WEB_RUNNER_NAME=operator-laptop
export REA_WEB_RUNNER_LABELS=local,macos
export REA_WEB_REA_ROOT="$PWD/.."              # the upstream checkout
export REA_WEB_RUNNER_WORKSPACE_ROOT="$HOME/.rea-web-runner"
# Optional:
export REA_WEB_RUNNER_LOCAL_TARGET_ALLOWLIST="$HOME/builds/app:$HOME/samples"
export REA_WEB_REA_PASSTHROUGH_ENV=REA_GHIDRA_INSTALL_DIR
node apps/runner/dist/main.js
```

On Windows (PowerShell; untested), set the same variables with `$env:NAME = "value"`.
The allowlist separator is `:` on every platform, so a Windows drive path
(`C:\...`) cannot be listed. This is a known limitation.

The runner registers its live capability report. Each allowlisted path is
registered as a `runner_local` target, and the UI's capability panel shows
upstream's own availability, with reasons and remediation. Stop the runner
with Ctrl-C. Running jobs are abandoned; their leases expire and are
requeued.

## Variables

| Name                                                                                                                                                                  | Meaning                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `REA_WEB_API_URL`                                                                                                                                                     | Control-plane origin. On a platform private network, use `REA_WEB_API_PRIVATE_HOST` and `REA_WEB_API_PORT` instead     |
| `REA_WEB_RUNNER_TOKEN`                                                                                                                                                | This runner's token (secret; redacted from logs)                                                                       |
| `REA_WEB_RUNNER_NAME`, `REA_WEB_RUNNER_LABELS`                                                                                                                        | Display name and comma-separated labels matched against job requirements                                               |
| `REA_WEB_REA_ROOT`                                                                                                                                                    | Path of the upstream REA checkout with `dist/mcp/main.js` built                                                        |
| `REA_WEB_RUNNER_WORKSPACE_ROOT`                                                                                                                                       | Private scratch directory for job workspaces                                                                           |
| `REA_WEB_RUNNER_MAX_JOBS`, `REA_WEB_RUNNER_SESSION_IDLE_MS`                                                                                                           | Concurrency, and how long an investigation's REA session stays open for follow-ups                                     |
| `REA_WEB_RUNNER_LOCAL_TARGET_ALLOWLIST`                                                                                                                               | `:`-separated paths this runner may read. They are addressed by `path_hash`, and nothing else on the host is reachable |
| `REA_WEB_REA_PASSTHROUGH_ENV`                                                                                                                                         | Comma-separated `REA_*` names passed to the REA child (provider configuration)                                         |
| `REA_WEB_MODEL_PROVIDER`, `REA_WEB_ANTHROPIC_API_KEY`, `REA_WEB_MODEL_ID`, `REA_WEB_MODEL_FALLBACKS`, `REA_WEB_MODEL_MAX_OUTPUT_TOKENS`, `REA_WEB_ANTHROPIC_BASE_URL` | Model follow-up loop. Set `disabled` unless a model budget is approved                                                 |
| `REA_WEB_RECOVERY_KEYS_DIR`                                                                                                                                           | Recovery keys (`<key id>.key`) for encrypted exports                                                                   |
| `REA_WEB_VERIFY_DATABASE_ADMIN_URL`, `REA_WEB_VERIFY_ALLOW_NETWORK`                                                                                                   | Restore-only database server and allowed network classes for verification                                              |
| `REA_WEB_RECOVER_BUNDLE`, `REA_WEB_CODE_TO_PRD_DIR`, `REA_WEB_LOG_LEVEL`                                                                                              | Embedded verifier path, vendored Code-to-PRD location, log level                                                       |

Capture credentials for builds, such as a database URL or bucket keys, are
read from this runner's environment, under the names each build declares.
They never pass through the control plane.

## Adding this host to the routing matrix

Probe the host and regenerate `docs/HOST-ROUTING.md`:

```sh
node tools/parity-matrix/probe.mjs --repo-root .. --out tools/parity-matrix/probes/<host>.json
node tools/host-routing/generate.mjs --probe tools/parity-matrix/probes/linux-x64-node22-no-providers.json.gz --probe tools/parity-matrix/probes/<host>.json
```

A host column reflects only what its probe observed.
