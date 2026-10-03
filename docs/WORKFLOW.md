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
make check                            # typecheck, lint, docs links, test with coverage, build, infra-check
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

`pnpm test:e2e` creates a database of its own on that same server before
Playwright starts, named with this host and the wrapper's process id,
migrates the empty database from this checkout, and drops it after
Playwright exits. It does not migrate the shared database. A shared database keeps the migration history of
whichever checkout last wrote it, and a later checkout cannot migrate a
history that names a migration it does not contain.

The wrapper also picks four free ports for the run, one each for the web
dev server, the API, the mock identity provider, and the fake workspace
agent. It passes them to Playwright as `PORTIKUS_WEB_PORT`,
`PORTIKUS_API_PORT`, `PORTIKUS_OIDC_PORT`, and `FAKE_AGENT_PORT`;
`e2e/ports.ts` reads them for the tests and `playwright.config.ts` for the
servers it starts. Any number of `pnpm test:e2e` runs on one machine can
therefore run at once. Arguments after `pnpm test:e2e` go to Playwright,
for example `pnpm test:e2e --shard=1/3`. A direct `playwright test` falls
back to the development ports 5173, 3000, 3002, and 7400. Playwright never
reuses a server already listening on a test port, so a taken port fails
the run instead of testing someone else's code. Stopping the wrapper with
Ctrl-C or SIGTERM passes the signal to Playwright, which stops the servers
it started before the run's database is dropped.

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
serves on (8443 on the pilot). For the pilot, `make` sets both for you
(`pilot.portikus.thewhittakers.org` and 8443). Without a name, the script's
HTTPS checks fall back to `portikus.<vm-ip>.nip.io` and it prints a
warning.

### Using the pilot from the host that runs it

The pilot is served at https://pilot.portikus.thewhittakers.org:8443
(docs/OPERATIONS.md, "The pilot"). The name resolves on the LAN's own DNS
server, and the site and its preview names use a Let's Encrypt
certificate, so a browser needs no hosts entry and no extra certificate
authority. One step is needed on the host, and again after
`make rebuild-pilot`, which already runs it:

```sh
make publish-vm
```

That forwards port 8443 on the host's LAN address to the VM, for traffic
arriving from the LAN and for connections the host itself makes.

To check the forward from the host:

```sh
curl -s -o /dev/null -w '%{http_code}\n' \
  https://pilot.portikus.thewhittakers.org:8443/            # 200
curl -s -o /dev/null -w '%{http_code}\n' \
  https://ws-<id>-<port>.preview.pilot.portikus.thewhittakers.org:8443/   # 401
```

A 401 from a preview name is the right answer: the request reached the
gateway, which turned it away because the curl call carries no session. A
connection error instead means the forward is missing.

A throwaway VM without a DNS name is served at `portikus.<lan-ip>.nip.io`
instead. nip.io is a public service that answers any such name with the
address inside it. Such a VM uses Caddy's own certificate authority, which
the browser must trust before an embedded preview works, because an iframe
cannot show a certificate warning (infra/README.md, "Browser access").

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

## Epic plans

An epic's detailed plan, `docs/EPIC-<n>.md` (its rulings, task table,
estimates and rehearsal steps), lives only on the epic branch, so every
agent working from a checkout can read it.

- Code comments, tests and other docs cite SPEC.md sections or ADRs,
  never the plan, because the plan goes away.
- The epic's last task folds the plan's lasting rules into SPEC.md in a
  sentence or two each, puts any "why" a later reader will ask into an
  ADR, and deletes the plan.
- Parallel task pull requests do not edit `docs/STATUS.md`, because
  they all conflict on it. Each one puts its proposed STATUS line (what
  it delivered, gaps left) in its pull request body instead.
- The fold task writes the epic's STATUS.md section once, from those
  pull request bodies.
- So `main` never holds a plan at a merge. Git history keeps it, and the
  epic pull request's commits show it to the reviewer.
- Plans of epics finished before this rule are kept in
  `docs/archive/epics/`; nothing new is added there.

Before a feature epic's plan is written, the architect agent designs it
(not for small fix batches). It reads wide: VISION.md, the epics still
to come in SPEC.md section 29, BACKLOG.md and the open issues for the
area. It reports where the code goes, what existing helpers and
contracts the builders must reuse, and which task owns each shared file,
migration number and contract change. For each significant choice it
gives the smallest change and the shape the area should have; it
recommends the smallest change unless the choice is hard to undo
(schema, contracts between apps, public APIs, protocols, installed file
formats), and brings large gaps to the user to decide. The plan cites
its report.

At each milestone gate in SPEC.md section 30, the architect also
reviews the whole system, one app or area per run, for layers and
boundaries that local decisions have bent. The user picks which
findings become an epic.

## Code style

- Comments say why, never history. Do not write issue or PR numbers,
  epic or task names, review codes, "ruling N", or pointers into epic
  plans; the history lives in version control, and plans are deleted.
  Cite a SPEC.md section or an ADR instead.
- Do not copy a helper. Search for one that does the job and import it;
  if two places need the same code, move it into a shared module.
- A value that must match in two files or processes is one exported
  constant, not two values and a comment.

`pnpm lint` runs `scripts/check-comment-history.mjs`, which fails on
history references in code comments and test titles; Knip, which fails
on unused files, exports and dependencies; jscpd, which fails on any
copied block of 70 tokens and 8 lines (a deliberate copy carries a
`jscpd:ignore-start` comment saying why); and Biome's cognitive
complexity rule, which fails on a function scoring over 30 (tests,
e2e and the test fakes are exempt). Biome also fails on an import
cycle, on an app or package importing an app, on `apps/web` importing
a server-side package, and on product code importing a `testing`
helper.

## Pull requests

Every pull request cites the SPEC.md and STACK.md sections it serves and
says how it was verified. The template asks for both. CI must be green.
An epic pull request must be up to date with `main` before it is merged;
`gh pr update-branch <number>` does that. Task pull requests into an
epic branch need not be up to date, because each update costs a full CI
run. They are updated only when GitHub refuses a merge because the
branch is behind.

There are two kinds of pull request, merged by different people at
different times:

- A task pull request, from a task branch into its epic branch, is merged
  by the merger agent as soon as its CI is green. No one reviews it by
  hand; review happens once, later, over the whole epic.
- An epic pull request, from an epic branch into `main`, is opened only
  after every task pull request for that epic has landed, code-reviewer,
  security-reviewer (when the epic touches auth, the preview gateway, the
  workspace agent, file APIs, Incus, or nested Docker) and a11y-reviewer
  (when the epic touches `apps/web` or `packages/ui`) have run over the
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
- **Docs links**: `scripts/check-docs-links.py` fails when a relative link
  or image in a tracked Markdown file points at a file that does not
  exist. It skips `docs/archive/`, web links and in-page anchors, and
  runs on every change. `make docs-check` runs it locally.
- **Application checks**: `pnpm install --frozen-lockfile`, typecheck, lint,
  tests with coverage (`pnpm test:coverage`), build. Skipped until
  `pnpm-workspace.yaml` exists. The run fails if coverage drops below the
  floors in `vitest.config.ts` (for example 80% of lines overall). The lcov
  report is uploaded as the `coverage-lcov` artifact and kept for three days. `make check` runs the
  same coverage command, so a local check catches the same failure.
- **Browser end-to-end tests**: `pnpm test:e2e` with Playwright, split
  across five parallel jobs, each with its own database service.
  `scripts/e2e-shard-list.mjs` packs the spec files into shards by the
  measured times in `e2e/shard-timings.json`; a file with no timing counts
  as the average. To refresh the timings after tests are added or slowed,
  run `node scripts/e2e-shard-list.mjs --refresh` (it reads the latest green
  CI run on main through `gh`) and commit the file. They start alongside
  Application checks rather than after it. A
  last job with the required name "Browser end-to-end tests" passes only
  when every shard passed. The Playwright browser download is cached.
  Skipped until the script exists.
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
hotfix. It builds the package from the merge commit on `main` and adds it
to the signed apt repository, which keeps the ten newest of the current
major.minor line and the newest of each earlier line. It also creates a
tagged GitHub release with notes and no files. Workspace images are
published as GitHub releases of their own, `image-<version>`, with the
image files as assets. The version is
`0.1.<commit count>+g<short sha>` and the tag is `v<version>`. A server
gets the release with `apt upgrade` and rolls back with
`sudo apt install --allow-downgrades portikus=<version>`. Task branches
publish too, so a change that lands outside an epic still gives servers a
release to install.

Two checks run before anything is published. First, the gate looks up the
pull request that produced the push. GitHub can take a few seconds to list
it, so the gate asks five times, ten seconds apart, and then fails, because
`main` changes only by pull request. Second, the package must name a
workspace image that is already released as `image-<V>`, where `<V>` is
`infra/workspace-image/VERSION`. When a merge bumps that version, the
Workspace image workflow builds the image on the same push, which takes
twenty minutes or more. The Release build waits for it, checking once a
minute for up to 75 minutes, before it builds or publishes anything. If
either check fails, fix the cause (for example, let the image workflow
finish or rerun it), then rerun the failed Release run from the Actions tab
with "Re-run all jobs". No release was created, so the rerun starts clean.

The signed apt index expires 30 days after it is signed (its
`Valid-Until` line), after which `apt update` refuses it. The same
workflow therefore runs every Monday and signs the index again with no new
package, unless a release signed it less than 6 days earlier. If that
weekly run fails, fix the cause and rerun it from the Actions tab with
"Re-run all jobs"; its gate checks the index's date again, so the rerun
signs it. There are about three more Mondays before the index expires.

Runs of this workflow never overlap, and GitHub keeps only one waiting run.
When a new run is queued while one is running and another is waiting, the
waiting one is cancelled, before its gate runs. A release cancelled by a
later merge needs nothing, because the later release has its commits. A
release cancelled by the Monday run publishes nothing: rerun it with
"Re-run all jobs".

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
