---
name: epic-run
description: Use when the orchestrator starts or continues a Portikus epic (a feature epic or a fix batch) and must take it from branch to a green epic pull request ready for Todd's merge.
---

# Running an epic end to end

The main session orchestrates; agents do the work (CLAUDE.md, "How work
gets done here"). Plans and folding follow docs/WORKFLOW.md, "Epic plans".
Keep a memory file for the epic with every ruling and a dated progress
line per step, so the run survives a context reset.

## Steps

1. **Branch.** `git fetch origin`, then cut `epic/<n>-<name>` from the
   current `origin/main` commit. Write that commit down; it is the base for
   every wave-one agent.
2. **Design (feature epics only).** Run architect before writing the plan.
   Fix batches skip this.
3. **Plan.** Write `docs/EPIC-<n>.md` (tasks, owner agent, files each task
   may touch, issues it closes) and land it on the epic branch through a
   plan PR. Ask Todd plan questions one at a time, each with a
   recommendation.
4. **Split tasks** so no two agents edit the same files. When files must
   overlap, put the later task in a second wave cut from the epic head
   after the first wave lands.
5. **Pick models** per CLAUDE.md "Delegation" and "Orchestration rules":
   Haiku for mechanical work, Sonnet at high effort when the prompt settles
   every choice, Opus for design or diagnosis.
6. **Write the shared rules file** in the scratchpad (template below) and
   point every task prompt at it. Each prompt adds the task row, the base
   commit, the files in scope, and what done looks like.
7. **Verify each report** before queuing: in the agent's worktree run
   `corepack pnpm typecheck` and `corepack pnpm lint` (builder, tester and
   ui-designer also run these in a Stop hook), read the diff, and rule on
   anything it did outside its file list.
8. **One merger queue.** Hand the ordered PR list to a single merger.
   Task PRs squash into the epic. Main-into-epic and epic-into-main use
   merge commits.
9. **Reviews** after every task PR has landed, on a read-only worktree at
   the epic head: code-reviewer always; security-reviewer and a11y-reviewer
   when CLAUDE.md "Review and merge rules" triggers them. Run them in
   parallel.
10. **Fix round.** Rule on each finding: fix now through task PRs, or
    record as a STATUS gap. Land fixes through merger, then have each
    reviewer confirm its findings are closed.
11. **Rehearsal VM full smoke** when the epic touches install, packaging
    or infra. One infra agent owns the rehearsal VM for the run. It must
    make a Dex sign-in file (two lines, email and password, mode 0600) the
    way `infra/tests/install-test.sh` `first_signin()` does; a smoke that
    skips the Dex sign-in is incomplete. The rehearsal VM is ours to
    change freely; this never applies to the pilot.
12. **Fold task** (last task PR): write the epic's STATUS section from the
    task PR bodies, move lasting rules into SPEC.md, delete the plan,
    record gaps, and carry a `Fixes #N` line for each issue. Check
    `git diff main...epic -- docs/STATUS.md` shows the section.
13. **Epic PR into main.** Cite the SPEC.md and STACK.md sections and how
    it was verified (WORKFLOW.md, "Pull requests"). One `Fixes #N` per
    line. Keep the body in the scratchpad and update it with
    `gh pr edit --body-file`.
14. **Check CI yourself.** `gh pr checks <epic PR>` must be all green, not
    just the merger's word; push runs skip jobs the PR run includes.
15. **Stop.** Report the PR and wait. Todd merges main.

## Gotchas

- Worktree agents start at `main`. Always give the exact base commit and
  tell them to `git reset --hard` to it.
- `gh pr update-branch` on an epic sometimes fails with a GraphQL error
  ("Something went wrong"). Merge main into the epic through a task branch
  and PR instead, landed with a merge commit.
- Keep an agent's worktree until its PR merges; removing it early makes the
  agent impossible to resume for a CI fix. After the merge, delete the
  branch and worktree without asking.
- Tell reviewers never to switch branches in the main checkout.
- A fresh worktree needs `corepack pnpm build` before e2e.
- Agents share the scratchpad; give each its own subfolder.
- An agent waiting on a merge can deadlock; tell running agents not to wait
  before pausing the queue.
- Never echo "merged" without checking `gh pr view N --json state`.

## Shared rules file template

```markdown
# Epic <n> shared rules for task agents

Epic <n>, branch `epic/<n>-<name>`, cut from main <commit>. The plan is
docs/EPIC-<n>.md on the epic branch; read your task's row.

- In your worktree: `git fetch origin && git reset --hard <base from your
  prompt>`, then `git switch -c task/<n>-<short-name>`.
- Node: the .nvmrc version must be first on PATH (the SessionStart hook
  does this; otherwise use its full path). Run `corepack pnpm install
  --frozen-lockfile`, and use `corepack pnpm` for every pnpm command.
- Database tests: a private, fresh test database named after your task
  (docs/WORKFLOW.md, "Local PostgreSQL for database tests").
- Scratchpad <path> is shared; use a subfolder named after your task.
- Tests first: a bug fix starts with a failing test. Design tests from the
  SPEC.md invariant. Anything a user can see ships with Playwright tests.
  Run only the affected specs locally; CI runs the full suite.
- Before the PR: typecheck, lint, and affected tests green (`make
  infra-check` for infra or packaging). Report commands and counts.
- Do not edit docs/STATUS.md, the plan, or SPEC.md section 29. Put a
  proposed STATUS line (delivered, gaps left) in the PR body.
- Never `git add -A`. No attribution lines. Never force-push; merge the
  epic branch in to catch up.
- PR into `epic/<n>-<name>`, not main. Body: `Refs #N`, the SPEC.md
  section served, how it was verified, the STATUS line. Do not merge.
- Stay inside your listed files; name any exception in the report.
- Never touch the pilot VM. Only the agent whose prompt says so may use
  the rehearsal VM.
- If a choice is left open, stop and report it rather than guessing.
- Report: PR number, head commit, what was built and left out, test
  commands with results.
```
