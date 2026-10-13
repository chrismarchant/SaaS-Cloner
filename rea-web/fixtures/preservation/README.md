# Preservation fixture

`app/` is the source of the throw-away git repository that
`packages/preservation/test/fixtureBuild.ts` builds for the preservation tests
(and, later, the verifier tests). Files that git or npm would treat specially
here are stored without their leading dot and renamed when the repository is
created: `gitignore`, `npmrc`, `nvmrc`, `env.example`.

The test builder adds, on top of these files: several commits, a tag, a branch,
a Git LFS model file, a submodule, an ignored `.env` that holds the fake secret
`sk_live_fixture_should_never_appear`, an uncommitted modification, an
untracked text file and an untracked binary. It also creates a PostgreSQL
database with two tables and a view, and an assets directory that contains a
symbolic link. Nothing in this directory is a real credential.
