# Pre-publish StreamOtter 0.2.0-rc.1 (temporary)

These six tarballs are StreamOtter `jfricano/StreamOtter@4e67ef8` (the head of its V1.2.1 PR, #56), with every package version set to `0.2.0-rc.1` and packed with `pnpm pack`. They let this branch build and test the source-failure exercises before 0.2.0-rc.1 is on npm.

They are not a release. When 0.2.0-rc.1 is published, one commit removes this directory, the `file:` specs in `apps/*/package.json`, the root `overrides`, and the two `COPY vendor vendor` lines in `deploy/Dockerfile`; pins `streamotter@0.2.0-rc.1` exactly; regenerates the lockfile from the registry; and re-records the Lab's real-Kafka evidence for the registry packages (`deploy/test/lab-source-failures.test.ts` and `deploy/test/sandbox.test.ts` re-run on that install, then `VERIFIED_WITH` updated: `npm test` fails until it is). Until then, `scripts/check-release-pins.mjs` keeps this branch out of every release:

- The Images and Deploy static site workflows run it first and refuse to build.
- The Release pins workflow (`.github/workflows/release-pins.yml`) runs it on every pull request whose base is `main`, including one retargeted onto `main`, so a vendored branch can't be merged there: phase 1's rebuilds and the site's rollback re-run build from `main`. It uses `main`'s copy of the script once `main` has one, so a pull request can't loosen the check it is held to. Pull requests into other branches (this branch's stacked bases) don't run it, and the CI workflow runs as before.
- Make **Release pins** a required status check for `main` in the repository's branch protection; until it is required, a failing check warns but doesn't block a merge.

See [docs/releases/v1.1/SOURCE_FAILURE_EXERCISES.md](../docs/releases/v1.1/SOURCE_FAILURE_EXERCISES.md).
