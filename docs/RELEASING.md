# Releasing sheperd to npm

rewire is published as one npm package, **`sheperd`**, plus four platform packages that each
hold a prebuilt `rewire-sandbox`: `sheperd-darwin-arm64`, `sheperd-darwin-x64`,
`sheperd-linux-x64` and `sheperd-linux-arm64`. The `@rewire/*` workspace packages are private
and are never published (they are bundled into `sheperd`).

| what | where |
| ---- | ----- |
| the `sheperd` manifest (version, optionalDependencies, files) | `npm/sheperd/package.json` |
| bundle, stage, check and pack | `scripts/npm/build.mjs` |
| install the tarballs and smoke-test them | `scripts/npm/smoke.mjs` |
| CI and publishing | `.github/workflows/release.yml` |

The platform packages' manifests are generated from `npm/sheperd/package.json`, so the version
lives in one file: `version` and the four `optionalDependencies` pins, which must all be equal
(`build.mjs` refuses anything else).

## One-time setup

1. **npm account.** Create an account at <https://www.npmjs.com/signup> and turn on two-factor
   authentication (Account settings, "Two-Factor Authentication", mode "Authorization and
   writes").
2. **Check the names are free.** `npm view sheperd` and `npm view sheperd-linux-x64` (and the
   other three) must return `E404`. If any is taken, the package names must change everywhere
   (`npm/sheperd/package.json`, `platformPackageName` in `packages/sandbox/src/client.ts`,
   `build.mjs`, the workflow).
3. **Automation token.** On npmjs.com: Access Tokens, "Generate New Token". Use a granular
   token with read and write access to packages (for the first publish it cannot yet be scoped
   to packages that do not exist; narrow it to the five packages afterwards), or a classic
   "Automation" token, which bypasses 2FA for CI. Set a short expiry.
4. **GitHub secret.** In the repository: Settings, Secrets and variables, Actions, "New
   repository secret", name `NPM_TOKEN`, value the token. Only the `publish` job of
   `release.yml` reads it. Optionally put that job behind a GitHub environment with required
   reviewers.

## Before tagging

- The version in `npm/sheperd/package.json` (and its four pins) is the version to release.
  The first release is `0.1.0-beta.1`.
- `main` is green in CI. The `ci` workflow's "npm package smoke test" step packs, installs and
  smoke-tests the packages on Linux x64 and macOS arm64 on every push and PR.
- Optionally run the release pipeline without publishing: Actions, `release`, "Run workflow"
  with `dry-run` ticked (the default). It builds all four binaries on native runners, packs all
  five packages, smoke-tests them, and stops.
- Locally (macOS arm64 example):

  ```sh
  pnpm install --frozen-lockfile && pnpm -r build
  node scripts/npm/build.mjs sandbox     # release build, local paths remapped
  node scripts/npm/build.mjs sheperd
  node scripts/npm/build.mjs platform    # this host's sheperd-<os>-<arch>
  node scripts/npm/build.mjs pack        # checks npm pack --dry-run, writes dist-npm/tarballs/
  node scripts/npm/smoke.mjs --faux-run  # installs the tarballs; --help, doctor, a faux run
  ```

## Publishing a release

```sh
git checkout main && git pull
git tag v0.1.0-beta.1
git push origin v0.1.0-beta.1
```

The tag push runs `release.yml`:

1. `plan` fails the run if the tag is not `v` + the version in `npm/sheperd/package.json`.
2. `sandbox` builds `rewire-sandbox --release` on `macos-15` (arm64), `macos-15-intel` (x64),
   `ubuntu-22.04` (x64) and `ubuntu-22.04-arm` (arm64), checks each binary's header matches
   its target (and, on Linux, that it needs no glibc newer than 2.35), and uploads it.
3. `package` bundles `sheperd`, checks and packs all five packages, and smoke-tests the
   tarballs (install, `rewire --help`, `rewire doctor` must find the sandbox in the platform
   package).
4. `publish` runs `npm publish --provenance --access public --tag next` for the four platform
   packages, then `sheperd`. A re-run skips the versions already on the registry.

A manual dispatch from the tag with `dry-run` unticked publishes the same way. A dispatch from
a branch with `dry-run` unticked fails: publishing always comes from a tag.

Check the result:

```sh
npm view sheperd dist-tags
npm i -g sheperd@next && rewire doctor
```

## Promoting to `latest`

Releases go to the `next` dist-tag, so `npm i -g sheperd` does not pick them up until promoted:

```sh
npm dist-tag add sheperd@0.1.0-beta.1 latest
```

The platform packages need no dist-tag: `sheperd` pins their exact version.

## Switching to trusted publishing

Once the five packages exist on npm, replace the long-lived token with npm trusted publishing
(OIDC):

1. On npmjs.com, for each of the five packages: Settings, "Trusted Publisher", GitHub Actions,
   repository `Abubakarjutt/sheperd`, workflow `release.yml`.
2. In `release.yml`, remove `NODE_AUTH_TOKEN` from the publish step (the job already has
   `id-token: write`; trusted publishing needs npm 11.5 or newer, so add
   `npm install -g npm@latest` before publishing if the runner's npm is older).
3. Delete the `NPM_TOKEN` secret and revoke the token on npmjs.com.
4. Optionally, in each package's settings, require 2FA and disallow tokens.

## Yanking a bad release

`npm deprecate sheperd@<version> "<reason>"`, then move the dist-tag back:
`npm dist-tag add sheperd@<good version> next`. `npm unpublish` is only possible within 72
hours and blocks the version number forever; prefer deprecating and releasing a new version.
