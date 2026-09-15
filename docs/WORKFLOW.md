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

`pnpm dev` builds the shared packages first, then runs each app under
`apps/` in watch mode: the API on port 3000 and the web app on port 5173,
which proxies `/health` to the API. `make help` lists every Make target.

Environment variables are validated by `loadConfig` in `packages/config`. A
missing or invalid variable fails at startup with a message naming it, so
add new variables to that schema and to `.env.example` together.

## Branches

- `main` is always releasable. It changes only through a pull request.
- Each epic in SPEC.md section 29 gets a long-lived branch named
  `epic/<n>-<slug>`, for example `epic/0-repo-conventions`. It also changes
  only through a pull request.
- Work happens on short-lived task branches cut from the epic branch, named
  `<epic-slug>/<task>`. A task branch is merged into its epic by pull
  request, squash merge.
- When an epic's acceptance criteria are met, the epic branch is merged into
  `main` by pull request, merge commit, so the epic's history is kept.
- Branches are deleted on merge.

## Pull requests

Every pull request cites the SPEC.md and STACK.md sections it serves and
says how it was verified. The template asks for both. CI must be green.
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

Each job detects whether its inputs exist and skips cleanly otherwise, so
the pipeline is green on a repo with no code and starts enforcing as code
lands. Do not remove the detection steps; remove the skip once a check is
expected to always run.

## Secret scanning

Remote: the CI secret-scan job, plus GitHub secret scanning and push
protection on the repository.

Local: a pre-commit hook runs gitleaks on staged changes. Enable it once per
clone:

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
