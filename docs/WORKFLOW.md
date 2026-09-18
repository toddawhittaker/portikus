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
make check                            # typecheck, lint, test with coverage, build, infra-check
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

The database `TEST_DATABASE_URL` names is not the one the tests use. Each test
file creates a database of its own on that same server, migrates it, and drops
it when the file finishes, so the files run in parallel and truncating tables
in one cannot disturb another. The name is the database from the URL plus the
process id of the run and a short hash of the test file path, for example
`portikus_test_p31337_1a2b3c4d`. The process id keeps two runs on one machine
apart, so several agents or sessions can share one `TEST_DATABASE_URL` without
tripping over each other.

Each file's connection pool is capped at four connections, because a whole run
holds a pool per database test file at once and PostgreSQL allows 100
connections by default.

If a run is killed part-way through, it never gets to drop its databases. The
next run cleans them up: before a test file creates its own database, it drops
every database on the server whose name starts with the base name plus a
host identifier and `_p`, and whose process id no longer belongs to a
running process. The host identifier limits the sweep to this machine's own
databases, because a process id only means something within the host (or
PID namespace) that assigned it, and several machines can share one
PostgreSQL server. Databases of a run still in progress are left alone, so
parallel runs on the same machine stay safe.

The Playwright run has the same problem for a different reason: its ports are
fixed, so two `pnpm test:e2e` runs on one machine fight over the API and web
dev server ports whatever database they use. Run the browser tests one at a
time.

### Logging in locally

Logging in uses a mock OpenID Connect identity provider that lives in this
repository (`packages/auth`). It has four fixed accounts:

| User | Role |
|---|---|
| `alice` | student |
| `bob` | student |
| `carol` | administrator |
| `dave` | no access; the API refuses the login with 403 |

Start it in a second terminal and leave it running:

```sh
MOCK_OIDC_REDIRECT_URI=http://127.0.0.1:5173/auth/callback \
  pnpm --filter @portikus/auth mock-oidc   # listens on http://127.0.0.1:3002
```

`MOCK_OIDC_REDIRECT_URI` is required: the mock only sends an authorization
code to that exact address, so a crafted link cannot bounce a code to
another site. `MOCK_OIDC_CLIENT_ID` and `MOCK_OIDC_CLIENT_SECRET` default to
`portikus-dev` and `portikus-dev-secret`, matching `.env.example`.

The API's development defaults already point at that address, so `pnpm dev`
plus the mock is all you need. Clicking "Sign in" sends you to the mock's
account list; pick a user and you land back on the web app signed in.

### Browser end-to-end tests

`pnpm test:e2e` now starts the mock provider and the API as well as the web
dev server, so it needs a database and compiled output:

```sh
# start the throwaway PostgreSQL from the section above, then:
export TEST_DATABASE_URL=postgres://postgres:portikus@127.0.0.1:55432/portikus_test
pnpm typecheck        # the started servers run dist/, so build it first
pnpm test:e2e
```

Without `TEST_DATABASE_URL` the tests fall back to that same throwaway URL.
CI sets it to its own PostgreSQL service container.

`pnpm dev` builds the shared packages first, then runs each app under
`apps/` in watch mode: the API on port 3000 and the web app on port 5173,
which proxies `/health` to the API. `make help` lists every Make target.

Environment variables are validated by `loadConfig` in `packages/config`. A
missing or invalid variable fails at startup with a message naming it, so
add new variables to that schema and to `.env.example` together.

### Infrastructure smoke test

`make smoke-test` runs `infra/tests/smoke-test.sh` against the platform VM
(STACK.md section 13, "Infrastructure smoke tests"). It creates its own
workspace through the API and deletes only the workspaces, Incus instances
and user rows it created; anything that already exists is listed and left
alone, and the lifecycle checks are skipped altogether when the VM already
holds any workspace. Even so, do not run it against a VM someone is using: it
stops and starts workspaces and, on a VM with none, it shortens the
platform-wide disconnect grace period for the length of the run. Set `PORTIKUS_PUBLIC_HOST` to the
name Caddy serves on that VM, and `PORTIKUS_PUBLIC_PORT` to the port it
serves on (8443 on the pilot); without the name the HTTPS checks fall back
to `portikus.<vm-ip>.nip.io` and the script prints a warning.

## Branches

- `main` is always releasable. It changes only through a pull request.
- Each epic in SPEC.md section 29 gets a long-lived branch named
  `epic/<n>-<slug>`, for example `epic/0-repo-conventions`. A fractional
  epic uses a dash for the point, as in `epic/3-5-<slug>`. It also changes
  only through a pull request.
- Work happens on short-lived task branches cut from the epic branch, named
  `<epic-slug>/<task>`. A task branch is merged into its epic by pull
  request, squash merge. Once its CI is green, the merger agent lands it
  and deletes the branch; no person reviews a task pull request.
- When an epic's acceptance criteria are met and its epic-level review is
  done (see "Pull requests" below), the epic branch is merged into `main`
  by pull request, merge commit, so the epic's history is kept.
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

There are two kinds of pull request, merged by different people at
different times:

- A task pull request, from a task branch into its epic branch, is merged
  by the merger agent as soon as its CI is green. No one reviews it by
  hand; review happens once, later, over the whole epic.
- An epic pull request, from an epic branch into `main`, is opened only
  after every task pull request for that epic has landed, security-reviewer
  (when the epic touches auth, the preview gateway, the workspace agent,
  file APIs, Incus, or nested Docker) and code-reviewer have run over the
  epic branch's head, every finding they required has been fixed or
  explicitly deferred, and the full local battery (`make check` plus
  Playwright against a fresh database) is green. Only the user merges an
  epic pull request into `main`.

The merger agent reruns a task pull request's CI up to twice when a failure
looks like a flake, a test unrelated to the change failing on a
timing-shaped error that also passed on an earlier run. A failure that
touches the changed files, or repeats after a rerun, is escalated to the
orchestrator rather than retried again; the merger agent never edits code
to make a check pass. `.claude/settings.json` grants agents permission to
run `gh pr merge` and read-only `gh` calls, which is what lets merger land
task pull requests without asking each time.

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to main:

- **Secret scan**: gitleaks over the full history of the branch.
- **Application checks**: `pnpm install --frozen-lockfile`, typecheck, lint,
  tests with coverage (`pnpm test:coverage`), build. Skipped until
  `pnpm-workspace.yaml` exists. The run fails if coverage drops below the
  floors in `vitest.config.ts` (for example 80% of lines overall). The lcov
  report is uploaded as the `coverage-lcov` artifact and kept for three days. `make check` runs the
  same coverage command, so a local check catches the same failure.
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

A `changes` job runs once, before the app, e2e, and infra jobs, and does
nothing but check out full history and detect what changed. It lists the
files changed in the pull request (against the base branch) or the push
(against the commit before it, or every tracked file on a brand new
branch), and exposes two job outputs: `app`, true when any changed path
falls outside `docs/`, `design/`, `screenshots/`, `.claude/`, and
root-level `*.md` files; and `infra`, true when any changed path is under
`infra/`, under `scripts/` or `packaging/`, is any other `*.sh` file, or is
the workflow file itself (a path under `scripts/` or `packaging/`, or any
shell script, sets both outputs, since those are exercised by both the
application build and the infrastructure shellcheck step). The app, e2e,
and infra jobs declare `needs: changes` and read these two outputs instead
of running their own copy of the detection script. The heavy steps in each
job (the installs, typecheck, lint, `test:coverage`, build, package build,
Playwright, and the OpenTofu, Ansible, and shellcheck steps) only run when
both the existing "does this input exist" detection and the matching
`needs.changes.outputs.*` value are true. A pull request that only touches
documentation, such as this paragraph, still gets four green checks (Secret
scan, Application checks, Browser end-to-end tests, Infrastructure checks),
because path filters on the workflow trigger are not an option: GitHub never
reports a status for a job a path filter skipped, and the branch protection
rules that require these checks would then block the merge forever. Running
the jobs but skipping their heavy steps keeps the checks reporting while
cutting the runtime on a docs-only change. Only the `changes` job needs
full history for the diff; the app, e2e, and infra jobs go back to a
shallow checkout since they only need the working tree.

`.github/workflows/release.yml` publishes a release when an `epic/` or
`task/` branch merges into `main`, or when the workflow is run by hand from `main` for a
hotfix. It builds the merge commit on `main` and builds the same package and publishes a GitHub release with two
assets: the `.deb` and a `SHA256SUMS` file. The version is
`0.1.<commit count>+g<short sha>` and the tag is `v<version>`. Ansible
installs the newest release by default and verifies it against that
release's `SHA256SUMS`; `make configure-vm PORTIKUS_VERSION=<ver>` installs
an older one for a rollback. Task branches publish too, so a change that
lands outside an epic still gives the VM a release to install.

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
