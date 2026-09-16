# Branching, review, and CI

## Local development

Prerequisites:

- Node.js at the major version in `.nvmrc`. With nvm: `nvm install && nvm use`.
- pnpm, enabled through Node's corepack: `corepack enable`. The exact pnpm
  version comes from the `packageManager` field in `package.json`.
- Playwright's browser, once per clone:
  `pnpm exec playwright install --with-deps chromium`.
- gitleaks, for the pre-commit hook (see "Secret scanning" below).
- For `make infra-check`, the same tools CI uses on `infra/`: OpenTofu
  (`make bootstrap-host` installs it), ansible-lint and Ansible
  (`pipx install --include-deps ansible-lint`), and shellcheck from your
  package manager.

Then:

```sh
git config core.hooksPath .githooks   # once per clone
pnpm install --frozen-lockfile
cp .env.example .env                  # .env is git-ignored; never commit it
make check                            # typecheck, lint, test, build, infra-check
pnpm test:e2e                         # Playwright browser tests
pnpm dev                              # every app in watch mode
```

### Local PostgreSQL for database tests

The `packages/db` tests run against a real PostgreSQL instance. If
`TEST_DATABASE_URL` is not set the tests skip with a log message. To run
them locally, start a throwaway container and export the URL:

```sh
docker run --rm -d --name portikus-test-pg \
  -e POSTGRES_PASSWORD=portikus -e POSTGRES_DB=portikus_test \
  -p 55432:5432 postgres:17
export TEST_DATABASE_URL=postgres://postgres:portikus@127.0.0.1:55432/portikus_test
pnpm test
docker rm -f portikus-test-pg
```

CI sets `TEST_DATABASE_URL` automatically via a `postgres:17` service
container, so database tests always run there.

`pnpm dev` builds the shared packages first, then runs each app under
`apps/` in watch mode: the API on port 3000 and the web app on port 5173,
which proxies `/health` to the API. `make help` lists every Make target.

Environment variables are validated by `loadConfig` in `packages/config`. A
missing or invalid variable fails at startup with a message naming it, so
add new variables to that schema and to `.env.example` together.

## Branches

- `main` is always releasable. It changes only through a pull request.
- Each epic in SPEC.md section 29 gets a long-lived branch named
  `epic/<n>-<slug>`, for example `epic/0-repo-conventions`. A fractional
  epic uses a dash for the point, as in `epic/3-5-<slug>`. It also changes
  only through a pull request.
- Work happens on short-lived task branches cut from the epic branch, named
  `<epic-slug>/<task>`. A task branch is merged into its epic by pull
  request, squash merge.
- When an epic's acceptance criteria are met, the epic branch is merged into
  `main` by pull request, merge commit, so the epic's history is kept.
- To sync changes from `main` into an epic branch, create a short-lived
  branch from the epic, merge `main` into it, and open a pull request back
  into the epic branch. The branch ruleset requires a PR for every push to
  `epic/**`, so a direct merge is not allowed.
- Branches are deleted on merge.

## Pull requests

Every pull request cites the SPEC.md and STACK.md sections it serves and
says how it was verified. The template asks for both. CI must be green.
A pull request branch must be up to date with its base before it is merged;
`gh pr update-branch <number>` does that.
Anything touching auth, the preview gateway, the workspace agent, file APIs,
Incus, or nested Docker is reviewed by the security-reviewer agent before
merge.

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to main:

- **Secret scan**: gitleaks over the full history of the branch.
- **Application checks**: `pnpm install --frozen-lockfile`, typecheck, lint,
  test, build. Skipped until `pnpm-workspace.yaml` exists.
- **Browser end-to-end tests**: `pnpm test:e2e` with Playwright. Skipped
  until the script exists.
- **Infrastructure checks**: `tofu fmt` and `tofu validate`, ansible-lint,
  shellcheck. Each skipped until the matching directory or files exist.
- **Package build**: builds the control-plane Debian package with `nfpm`
  (ADR 0007) and uploads it as a build artifact kept for seven days.

Each job detects whether its inputs exist and skips cleanly otherwise, so
the pipeline is green on a repo with no code and starts enforcing as code
lands. Do not remove the detection steps; remove the skip once a check is
expected to always run.

`.github/workflows/release.yml` publishes a release when an epic branch
merges into `main`, or when the workflow is run by hand from `main` for a
hotfix. It builds the merge commit on `main` and builds the same package and publishes a GitHub release with two
assets: the `.deb` and a `SHA256SUMS` file. The version is
`0.1.<commit count>+g<short sha>` and the tag is `v<version>`. Ansible
installs the newest release by default and verifies it against that
release's `SHA256SUMS`; `make configure-vm PORTIKUS_VERSION=<ver>` installs
an older one for a rollback.

## Secret scanning

Remote: the CI secret-scan job, plus GitHub secret scanning and push
protection on the repository.

Local: a pre-commit hook runs gitleaks on staged changes, then the same
Biome check CI runs (`biome check --error-on-warnings`) on the staged
TypeScript, JavaScript, JSON, and CSS files. A commit that would fail CI
lint is refused before it is made. Enable the hook once per clone:

```sh
git config core.hooksPath .githooks
```

Install gitleaks from https://github.com/gitleaks/gitleaks/releases or your
package manager. Files that legitimately contain secret-shaped strings are
allowlisted in `.gitleaks.toml`.

## Dependencies

Dependabot runs weekly and groups minor and patch updates into one pull
request. Major updates get their own. Versions are pinned exactly and the
lockfile is committed.
