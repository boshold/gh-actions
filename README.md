# gh-actions

Shared GitHub Actions workflows and actions for Nuxt apps, Nuxt modules, TypeScript libraries and CLIs, binaries and Docker images. The repo is public so public and private repositories can both call it.

Callers pin `@v1`. The `v1` tag moves with every `v1.x.y` release.

```yaml
jobs:
  ci:
    uses: boshold/gh-actions/.github/workflows/nuxt-ci.yml@v1
```

Copy a starting point from [`templates/`](templates) and adjust it.

| Template | For |
|---|---|
| `nuxt-app/` | Nuxt app with Postgres, Docker image, preview, stage and production deploys (Dokploy) |
| `nuxt-module/` | Nuxt module on GitHub Packages, optional demo deploy |
| `ts-lib/` | TypeScript library or CLI on GitHub Packages |
| `ts-lib-npmjs/` | Release to npmjs.com with trusted publishing and provenance |
| `binary/` | Go, Rust or Bun binaries attached to the GitHub release |
| `prisma.yml` | Migration check that only runs when `prisma/**` changes |
| `dependabot.yml` | Weekly updates with a cooldown |

## Runners

Every job picks its runner with the same expression:

```yaml
runs-on: ${{ inputs.runner-standard || (github.event.repository.private && vars.CI_RUNNER_STANDARD) || 'ubuntu-latest' }}
```

- Public repositories always run on GitHub-hosted runners. `CI_RUNNER_*` variables are ignored there, so a public repository can never land on a self-hosted runner.
- Private repositories use the `CI_RUNNER_LIGHT`, `CI_RUNNER_STANDARD`, `CI_RUNNER_ARM64` and `CI_RUNNER_MACOS` repository or organization variables, and fall back to GitHub-hosted runners when a variable is not set.
- A `runner-*` input overrides both.

Nothing in this repo decides which runner a private repository should use. That lives elsewhere and only writes the variables.

Self-hosted runners need runner version 2.336.0 or newer, because the workflows load their own actions with `uses: $/...` (see [Development](#development)). Set `CI_LOCAL_CACHE=1` in the runner environment when the runner keeps a persistent pnpm store; the GitHub cache is then skipped.

## CI stages

`nuxt-ci.yml` and `node-ci.yml` take a `stage` input:

| Stage | Runs | Typical trigger |
|---|---|---|
| `fast` | lint, typecheck, unit tests in one job (`parallel: true` splits them) | pull request |
| `full` | fast, plus services, migrations, Prisma check, seed, slow tests, e2e, build, image build and smoke, supply chain | push to main, `ci:full` label |
| `release` | full, plus the node/OS matrix and release-only extra tests | release workflow |

Each test type is a command input (`lint-command`, `typecheck-command`, `test-command`, `test-full-command`, `e2e-command`, `build-command`). An empty command turns that step off.

`extra-tests` adds custom jobs as a JSON array. Each entry gets its own job:

```yaml
extra-tests: |
  [
    {"name": "gateway e2e", "stage": "full", "compose": "test/compose.yml", "hosts": ["app.test"],
     "background": ["node .output/server/index.mjs"], "setup": "pnpm build",
     "wait-url": "http://127.0.0.1:3000/api/health", "command": "pnpm test:gateway",
     "artifacts": ["test/logs/**"]},
    {"name": "bun", "stage": "release", "bun": "file", "command": "pnpm test:bun"}
  ]
```

Keys: `name` and `command` are required. Optional: `stage` (default `full`), `runner` (`light`, `standard`, `arm64`, `macos`), `services`, `compose`, `compose-services`, `hosts`, `setup`, `background`, `wait-url`, `wait-seconds`, `env` (string or object), `playwright`, `bun`, `node-version`, `artifacts`, `working-directory`, `timeout`.

What keeps the fast stage fast:

- One install per job, Nuxt prepared once. ESLint cache restored. `NUXT_TELEMETRY_DISABLED=1`.
- Services start only in the `verify` job, once. The image is built in the same job, so the database and Mailpit are not started twice.
- Docker builds use the BuildKit GitHub Actions cache (`type=gha`), scoped per Dockerfile.
- Playwright browsers are cached by the resolved Playwright version. On a cache hit only the OS packages are installed.
- `nuxt-build-cache: true` caches `node_modules/.cache/nuxt` for Nuxt's `experimental.buildCache`.

## Workflows

| Workflow | What it does |
|---|---|
| `nuxt-ci.yml` | Nuxt app CI with stages, Postgres/Mailpit/compose, Prisma check, Playwright, image build, smoke and push. Output `image-digest`, `image`. |
| `node-ci.yml` | CI for libraries, CLIs and Nuxt modules (`preset: nuxt-module`). Pack-and-install smoke, node/OS matrix. |
| `extra-tests.yml` | The `extra-tests` jobs, used by both CI workflows. Callable on its own. |
| `prisma-check.yml` | Migration checks against one or more databases (Postgres, SQLite) plus parity between them. |
| `release-npm.yml` | Version, build, tag, GitHub release, publish to GitHub Packages. |
| `release-image.yml` | Version, build image, smoke, scan, push, tag `vX.Y.Z`/`X.Y.Z`/`latest`, release with SBOM. |
| `release-tag.yml` | Version, tag and GitHub release only. Optional assets with SHA256SUMS. |
| `release-demo.yml` | Demo image of a module's playground, deployed to Dokploy and stopped again. |
| `deploy-dokploy.yml` | Deploy an image to Dokploy with a GitHub deployment record, backup gate, health check and rollback. With `preview-pr`, re-checks preview slot ownership under the deploy lock and skips stale runs. |
| `preview-placeholder.yml` | Builds the "no preview deployed" placeholder image. |

## Actions

Workflows use these internally. They can also be used directly as `boshold/gh-actions/.github/actions/<name>@v1`.

| Action | What it does |
|---|---|
| `setup` | pnpm and Node (Bun optional), pnpm store cache, scoped registry auth, install |
| `run` | Runs a command with multiline `env` and masked `env-secrets` |
| `services` | Postgres (container or PGDG binaries), Mailpit, docker compose |
| `playwright` | Browser install with a version-keyed cache |
| `image-build` | Buildx build with GHA cache, load or push |
| `image-smoke` | Boots an image and checks `/api/health` |
| `prisma-check` | Migration deploy, drift and SQL checks |
| `supply-chain` | Opt-in `pnpm audit`, Trivy, SBOM (blocking) |
| `coverage` | Vitest coverage comment on pull requests |
| `npm-publish` | Publish to npmjs.com or GitHub Packages, skips versions that already exist |
| `release-version` | Next version, bumps manifests, release commit and tag |
| `release-publish` | Default-branch gate, atomic push, GitHub release |
| `release-assets` | Uploads files and SHA256SUMS to a release |
| `ci-status` | Checks whether a workflow already passed for a commit |
| `preview-slot` | Decides which pull request owns the single preview deployment |
| `dokploy-deploy` | Dokploy deploy, backup gate, health wait, rollback |

## Releases

Releases always go through CI first. The caller's `release.yml` is a manual `workflow_dispatch`:

1. `bump`: `patch`, `minor`, `major`, or a prerelease bump (`prerelease`, `prepatch`, `preminor`, `premajor`, with `preid`, default `rc`).
2. The caller's CI runs with `stage: release`.
3. When it is green, a `release-*` workflow bumps the version, commits `chore(release): vX.Y.Z`, tags, pushes, creates the GitHub release and publishes.
4. Optional deploy jobs follow.

Details:

- The next version is the highest `vX.Y.Z` tag plus the bump. Root `package.json`, pnpm workspace manifests, `Cargo.toml` (including workspace members) and `version-files` are updated.
- A failed release can be re-run. If the release commit is already tagged, the run continues with the same version instead of bumping again.
- Only the default branch can release. `dry-run: true` works from any branch and pushes nothing.
- The push uses `github.token` unless a `release-token` secret is passed. Use a GitHub App token when the default branch is protected. Pushes made with `github.token` do not start other workflows.
- Images are built once and pushed untagged by digest. Smoke test, scan and SBOM run on that pulled digest, and tags are added to it only after they pass, so the published bytes are the tested ones. `latest` only moves for the highest stable version.
- The image scan (Trivy, fixable HIGH/CRITICAL) reports to the job summary with a warning and does not block the release; `scan-fail: true` makes it blocking. Dependabot (see `templates/dependabot.yml`, including the `docker` ecosystem) keeps dependencies and base images current.
- The same applies to `nuxt-ci.yml` with `image-push: true`: `verify` pushes and tests the digest, `image-push` tags it once every job is green. Failed runs leave untagged versions in GHCR. Set a cleanup policy for untagged versions on the package (for example [actions/delete-package-versions](https://github.com/actions/delete-package-versions) with `delete-only-untagged-versions: true` on a schedule).
- npmjs.com: trusted publishing is bound to the caller's workflow file, so publishing runs in the caller's job with the `npm-publish` action. See `templates/ts-lib-npmjs/release.yml`.

## Contracts

The image and deploy steps expect:

- `GET /api/health` returns `200` with `{"status": "ok", "revision": "<git sha>"}`. The placeholder image returns `{"status": "idle"}`.
- The Dockerfile reads `ARG DEPLOYMENT_REVISION` (and `APP_VERSION` for releases) and bakes it in. The smoke test checks the baked value; it does not inject it.
- Private registry packages are passed as a BuildKit secret with id `github_npm_token`, never as a build argument. Build arguments end up in the image provenance.
- Labels: `preview` (preview slot), `ci:full` (full CI on a pull request), `migration:destructive` (allows destructive SQL at Prisma level `strict`).

Secrets callers usually pass: `packages-token` (read access to GitHub Packages), `dokploy-api-key`, `release-token` (optional). Do not put secrets in `env`; use `env-secrets`, which is masked.

## Prisma check

Levels:

| Level | Checks |
|---|---|
| `basic` | `migrate deploy` on an empty database, schema drift |
| `standard` | basic, plus merged migrations unchanged, `migration_lock.toml` provider, destructive SQL as a warning |
| `strict` | standard, destructive SQL is an error on pull requests unless the PR has the `migration:destructive` label; an unknown base fails |

`require-transaction: true` requires new migrations to start with `BEGIN;` and end with `COMMIT;`. Prisma 7 (`prisma.config.ts`) is required.

## Development

```sh
node --test 'tests/**/*.test.mjs'          # JS action tests
tests/prisma-check/run.sh sqlite           # needs pnpm install in tests/prisma-check/fixture
tests/image-smoke/run.sh                   # needs docker
```

The reusable workflows reference their own actions as `uses: $/.github/actions/<name>`. GitHub resolves `$/` to this repository at the commit of the running workflow, so a caller on `@v1` gets the `v1` actions and a pull request here tests its own changes. `self-test.yml` runs every workflow against `tests/fixtures/app`.

Release this repo with the `Release` workflow. It runs the self test, tags `vX.Y.Z` and moves `vX`.
