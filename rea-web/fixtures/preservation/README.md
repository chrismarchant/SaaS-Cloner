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

## Platform fixture

`platform/` is a second, config-only source tree for the platform-configuration
collectors (`packages/preservation/test/platform*.test.ts`). It holds realistic
`railway.json`, `railway.toml` (in `services/worker/`), `fly.toml`,
`vercel.json`, `netlify.toml`, a `Procfile` and `supabase/config.toml` (two
enabled OAuth providers with `env(...)` references, redirect URLs, two
buckets) with two function directories next to a `_shared` helper. Fixture
helpers copy it, rename `dot-railway/` to `.railway/` (the Railway
infrastructure-as-code file, which is detected and never evaluated) and, for
capture tests, commit it to a throw-away git repository. The values are
placeholders; nothing here is a credential.
