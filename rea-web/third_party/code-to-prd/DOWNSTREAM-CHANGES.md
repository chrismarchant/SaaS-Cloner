# Downstream changes to Code-to-PRD

Vendored from https://github.com/alirezarezvani/claude-skills at
`19392f7a08264ed00486a251f5b2098321771f94`, path
`product-team/code-to-prd/skills/code-to-prd/`, under the MIT license in
`LICENSE` (copied from the repository root).

Changes relative to upstream:

- `scripts/.gitignore` (content `prd/`) was not vendored; it only ignored the
  skill's own sample output directory.
- `upstream-settings.json` is the upstream `product-team/code-to-prd/settings.json`
  kept for version/author provenance.
- No source modifications. The extension invokes `codebase_analyzer.py` and
  `prd_scaffolder.py` as subprocesses with argument arrays (`python3 -I`),
  and post-processes their JSON/Markdown output in
  `rea-web/packages/preservation/src/product/`.
- Markdown and JSON files under this directory were reformatted with the
  upstream repository's `oxfmt` configuration (whitespace/table alignment only)
  so that the root `npm run format:check` gate passes without editing upstream
  configuration. The Python scripts are byte-identical to the pinned source;
  see the SHA-256 values in `rea-web/docs/UPSTREAM-PROVENANCE.md`.
