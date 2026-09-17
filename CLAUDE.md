# CLAUDE.md

Guidance for Claude Code in this repository. Portikus is a browser-based
agentic development workspace for students. Keep this file under 150
lines. It holds only pointers and process rules: how work is delegated,
tested, reviewed, and merged. Status, history, architecture, and anything
that describes what the code does belong under `docs/`, cited by file and
section, never here.

## Where things are documented

- `docs/OVERVIEW.md`: one-page orientation and the design rules every
  change must respect. Read this first.
- `docs/STATUS.md`: what each epic and task has delivered and the gaps it
  left. Update it in the same pull request that lands the work.
- `docs/VISION.md`: product intent. Wins on questions of intent.
- `docs/SPEC.md`: requirements. Wins on implementation detail. Section 29
  lists epics in order, section 30 milestone gates, section 24 security.
- `docs/STACK.md`: technology choices and why. Section 2 is the repo
  layout, section 13 testing, section 15 observability, section 31 the
  Make targets, section 34 the stack summary, section 35 what was rejected.
- `docs/WORKFLOW.md`: local development, branching, pull requests, CI,
  secret scanning, and the pre-commit hook.
- `docs/DESIGN.md`: the visual design, mirrored under `design/`.
- `docs/adr/`: decision records. Add one for any choice a later reader
  would ask "why" about.

Before implementing any subsystem, read the SPEC.md and STACK.md sections
that cover it. Cite sections by number in prompts, commits, and reports.

## Layout and commands

`apps/` holds the five processes (api, worker, workspace-controller,
workspace-agent, web), `packages/` the shared libraries (contracts,
config, events, db, auth, observability, ui), `e2e/` the Playwright tests,
`infra/` the VM, image, and Ansible, `packaging/` the Debian package.
STACK.md section 2 describes each.

Prerequisites: the Node version in `.nvmrc` (run `nvm use` first; the
machine default is newer) and pnpm through `corepack enable`.

| Command | What it does |
|---|---|
| `pnpm install --frozen-lockfile` | Install from the committed lockfile |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | The three fast checks |
| `pnpm test:coverage` | Tests with the coverage floors CI enforces |
| `pnpm test:e2e` | Playwright browser tests |
| `pnpm build` / `pnpm dev` | Build everything, or run every app in watch mode |
| `make check` | typecheck, lint, test with coverage, build, infra checks |
| `make build-deb` / `make deploy-app` | Build the Debian package, install it on the VM |

`make help` lists every target. Prefer a Make target over an invented
command. Database tests need `TEST_DATABASE_URL` (WORKFLOW.md, "Local
PostgreSQL for database tests").

## How work gets done here

The main session is an orchestrator: understand the request, write good
prompts, spawn agents, verify their claims, and report in plain English.
It does the work itself only for a one-line lookup or edit. Agents live in
`.claude/agents/`:

| Agent | Use for |
|---|---|
| explorer | Finding where things are. Cheap. Feed its report to other agents. |
| builder | Implementing a scoped change against a named SPEC.md section. |
| tester | Designing tests that pin SPEC.md invariants, then running them. |
| security-reviewer | Read-only review against SPEC.md section 24 trust boundaries. |
| code-reviewer | Read-only review for correctness, then YAGNI/KISS/DRY/SOLID quality. |
| infra | Anything under `infra/`: OpenTofu, Ansible, cloud-init, Incus, images. |

Orchestration rules:

- Delegate to the cheapest agent that can do the job. Run explorer first
  when a location is unknown and pass its paths on, rather than making a
  stronger agent search.
- Run independent agents in parallel. Never let two agents edit the same
  files; split by package or directory and merge in the main session.
- A good prompt names the SPEC.md and STACK.md sections, the files in
  scope, the base commit, what done looks like, and what to leave alone.
- Agent worktrees start at `main`. Tell a worktree agent the exact commit
  to reset to, and land its work with `git diff <base> <head> | git apply
  --3way`, not a rebase.
- Verify before relaying. Run `pnpm typecheck` and `pnpm lint` on an
  agent's work before calling it done; a builder's "lint passes" has been
  wrong before.
- When agents disagree, read the spec section in dispute and rule. If the
  spec does not settle it, bring both positions and a recommendation to
  the user. Say what was ruled in the report.
- Default effort is low. Raise it for one task when it needs sustained
  reasoning, high for intensive debugging. Time-box debugging agents.
- Never `git add -A`; stage paths explicitly, above all under `infra/`.
- Delete local branches and agent worktrees after a merge.

## Testing rules

- Tests are part of done. A change ships with unit tests for its logic,
  and any change a student or administrator can see ships with Playwright
  tests too. Design tests from the SPEC.md invariant, not from what the
  code happens to do.
- Write the test first when the behavior is clear enough to state; at
  minimum, a bug fix starts with a failing test that reproduces it.
- Coverage must stay above the floors in `vitest.config.ts`. Do not lower
  a floor to make a run pass; say so and let the user decide.
- Before a pull request: `make check` and `pnpm test:e2e` green locally,
  with a fresh test database, because a shared one hides gaps.
- Infrastructure changes are verified on this host from bootstrap through
  the smoke test before their pull request is opened.

## Review and merge rules

- Send anything touching auth, the preview gateway, the workspace agent,
  file APIs, Incus, or nested Docker through security-reviewer before it
  is called done.
- Run code-reviewer over a task or epic branch before its pull request
  and fix or explicitly defer every finding it requires.
- `main` and epic branches change only by pull request, CI must be green,
  and the pull request cites the SPEC.md and STACK.md sections it serves
  and says how it was verified (WORKFLOW.md, "Pull requests").
- Merging is the user's decision. Prepare the pull request, report, and
  stop.

## Design defaults

- Build only what was asked. No options, abstractions, or files for needs
  nobody has today.
- Prefer boring, mature technology with explicit interfaces over framework
  magic (STACK.md, "Purpose"). Use what is already in the repo before
  adding a dependency, and say why if you add one.
- Pin exact dependency versions and commit the lockfile.
- Never write code that commits, branches, tags, or stashes in a user's Git
  repository on the platform's behalf (SPEC.md section 12.5).
- The platform never logs secrets, prompts, source code, or terminal bytes
  (STACK.md section 15, ADR 0012).
