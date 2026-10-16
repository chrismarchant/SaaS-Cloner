# Upstream provenance

This repository is a downstream extension of REA. Everything outside `rea-web/`
is upstream-owned and is preserved unchanged at the pinned revision below;
everything under `rea-web/` is the downstream extension.

## Pinned upstream

| Field                   | Value                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------- |
| Upstream URL            | https://github.com/morluto/rea                                                     |
| Upstream default branch | `main`                                                                             |
| Imported commit         | `c22111eca2c4bc84a084f12711f405b3e7422a40`                                         |
| Imported commit subject | `fix(process): return private runtime ownership at allocation`                     |
| Upstream commit date    | 2026-10-12T16:30:53+08:00                                                          |
| Import date             | 2026-10-12 (UTC)                                                                   |
| Package                 | `rea-agents@6.4.0` (`package.json`), MCP name `io.github.morluto/rea`              |
| Nearest upstream tag    | `rea-agents-6.4.0` (release-please tag family `rea-agents-*`)                      |
| History imported        | Full history: 2,485 commits reachable from `upstream/main`, plus all upstream tags |
| License                 | MIT, `Copyright (c) 2026 morluto` (`LICENSE`)                                      |
| Third-party notices     | `THIRD_PARTY_NOTICES.md`, `licenses/` (npm inventory, Ghidra, MinGW, Node, etc.)   |

## Git topology in the destination

| Ref                                | Purpose                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| remote `upstream`                  | Fetch-only remote for https://github.com/morluto/rea.git. Never pushed to.                   |
| remote `origin`                    | Destination (`chrismarchant/SaaS-Cloner`). Receives only the implementation branch and tags. |
| tag `upstream-baseline-c22111e`    | Immutable annotated tag on the imported upstream commit.                                     |
| branch `upstream-baseline`         | Immutable branch on the same commit, kept for diffing (`git diff upstream-baseline...HEAD`). |
| branch `claude/zen-lamport-ijxd7w` | Implementation branch. Its first commit is the upstream commit, so ancestry is preserved.    |

Upstream refs are not mirror-pushed into the destination. Only the baseline
tag/branch and the implementation branch are published.

To verify the preserved baseline at any time:

```sh
git diff --stat upstream-baseline...HEAD -- . ':(exclude)rea-web'
```

An empty result means no upstream-owned file has been modified by the extension.

## Submodules

`.gitmodules` declares five submodules under `third_party/`. They are source
references for provenance and optional verification lanes; the deterministic
build (`npm run build:cached`, `npm run test:prepare`, `vitest run`) completes
without initialising them, as verified at G00.

| Path                            | URL                                                 | Pinned SHA                                 | Initialised at G00 |
| ------------------------------- | --------------------------------------------------- | ------------------------------------------ | ------------------ |
| `third_party/jadx-headless-mcp` | https://github.com/1013503897/jadx-headless-mcp.git | `5844800a486d2248fa949b74c9896285f5b54de2` | no                 |
| `third_party/binwalk`           | https://github.com/ReFirmLabs/binwalk.git           | `4fdab3d464d97b68e0af9088df3f9e2e1545b21c` | no                 |
| `third_party/unblob`            | https://github.com/onekey-sec/unblob.git            | `1fcc7a0a584a70a96c31f5a276c20944d199a089` | no                 |
| `third_party/ghidra-nativeaot`  | https://github.com/Washi1337/ghidra-nativeaot.git   | `effeb734fc570c32650f88b159608979dc7b423e` | no                 |
| `third_party/wakaru`            | https://github.com/pionxzh/wakaru.git               | `8219bf5016a063d7fb215101a8c45d5959ec733f` | no                 |

Git LFS: `.gitattributes` declares no LFS filters; there are no LFS objects.

## Upstream layout retained

The upstream single-package layout (`src/`, `tests/`, `scripts/`, `bridge/`,
`docs/`, `website/`, `.agents/skills/`, root `package.json` with Turbo tasks) is
retained unchanged. The extension lives in a single new top-level directory,
`rea-web/`, which is its own npm workspace root with its own lockfile so that
upstream's `npm ci`, `turbo.json`, `knip.json`, `tsconfig.json` and CI remain
untouched. Root `oxfmt --check .` and `oxlint` traverse the whole tree, so
`rea-web/` sources are kept conformant with upstream's `.oxfmtrc.json` and
`.oxlintrc.json` rather than adding ignore entries to upstream config.

## Third-party material added by the extension

### Code-to-PRD (product documentation generator)

| Field              | Value                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source repository  | https://github.com/alirezarezvani/claude-skills                                                                                                                                   |
| Source path        | `product-team/code-to-prd/skills/code-to-prd/` (plus `product-team/code-to-prd/settings.json`)                                                                                    |
| Pinned revision    | `19392f7a08264ed00486a251f5b2098321771f94` (default branch `main`, committed 2026-08-26T15:53:02+02:00)                                                                           |
| Skill version      | `2.1.2` (`SKILL.md` front matter and `settings.json`)                                                                                                                             |
| License            | MIT, `Copyright (c) 2025 Alireza Rezvani` (repository `LICENSE`, copied to `rea-web/third_party/code-to-prd/LICENSE`)                                                             |
| Vendored to        | `rea-web/third_party/code-to-prd/`                                                                                                                                                |
| Runtime deps       | Python 3 standard library only (`codebase_analyzer.py`, `prd_scaffolder.py` import argparse/json/os/re/pathlib/typing)                                                            |
| Script SHA-256     | `codebase_analyzer.py` `a282e67b5f5fdcdee7264b704ccb4ccae2a1fd136ba6405e0ee6949941cb2148`; `prd_scaffolder.py` `87b443cc8abe3f1689432163d723c8bf4c667925f9ee88433dfa9ec83518d230` |
| Local modification | None at import. Downstream changes, if any, are recorded in `rea-web/third_party/code-to-prd/DOWNSTREAM-CHANGES.md`.                                                              |

The third-party listings named in the directive (skillvault.md and
typingmind.com) were unreachable from the build environment's network policy
(`getaddrinfo ENOTFOUND`) and were therefore not used as sources. They are
treated as directories only; the pinned GitHub revision above governs the
implementation.

### TypingMind listing of `reverse-engineer-anything`

The TypingMind listing is a third-party mirror of the upstream skill at
`.agents/skills/reverse-engineer-anything/SKILL.md` (metadata version `39` at the
pinned revision). The repository copy governs; the listing was not reachable
from the build environment and nothing was copied from it.

## Baseline verification at import

See `rea-web/docs/verification/G00-baseline.md` for the exact commands, exit
codes, durations, and the classification of every check as passed, failed,
environment-blocked, or unavailable (live provider).
