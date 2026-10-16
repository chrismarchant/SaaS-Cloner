# Recovery fixture

No recovery package, database dump, git bundle or tar is committed here, and
none should ever be.

The clean-restore end-to-end test (`tests/e2e/recovery.test.ts`, gate G04)
builds its package at test time from the preservation fixture
(`fixtures/preservation/app` plus the throw-away repository, PostgreSQL
database and assets directory that `packages/preservation/test/fixtureBuild.ts`
creates). It then:

1. captures the build with the freshly built `rea-recover.mjs` embedded,
2. exports the package as a tar and copies only that tar into an empty directory,
3. unpacks it and runs the _embedded_ verifier against an empty disposable
   database and an empty target, with `PATH` and one database-URL variable as
   the whole environment,
4. checks the restored tree, the invariant and the report, and runs the
   tamper, blocked-host and registry-step negative cases.

`expectations.json` is the static description of what that test expects. It
contains no secrets: the fixture "secret" is the fake marker defined in
`fixtureBuild.ts`, and the database role and password are generated per run.
