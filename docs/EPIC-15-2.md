# Epic 15.2: pilot fixes

Branch `epic/15-2-pilot-fixes`, cut from `main` at `941d384`. Milestone 7,
"Epic 15.2: pilot fixes". This plan lives only on the epic branch; the last
task folds its lasting rules into SPEC.md and deletes it (WORKFLOW.md,
"Epic plans").

## Tasks

Each task is one pull request into the epic branch. Tasks own the areas
listed and stay out of the others' areas.

| Task | Issues | Backlog entries folded in | Area |
|---|---|---|---|
| T1 (priority) | #848 Claude Code login waits for a localhost callback | none | Workspace environment, URL broker |
| T2 | #849 narrow scrollback after a resize | none | Web terminal, tmux settings |
| T3 | #816 image and PDF viewer | "Markdown relative images through the file route" and "Relative Markdown image paths resolve against the workspace" | Web file viewer, Markdown rendering, file-read route |
| T4 | #817 "Extract here" for zip files | "Zip-slip tests for archive extraction" (new extractor and recovery restore) | Agent extract route, Files pane menu |
| T5 | #846 clone name, #847 branch `main`, #856 `.portikus` ignore, #857 `.portikus/README.md` | "`INTERNAL` instead of `TMUX_FAILED` for other project route errors" | Agent project routes, clone dialog |
| T6 | #858 agent instructions template, copied once | none | Package files, workspace image; also system `init.defaultBranch main` for #847 |
| T7 | #859 log noise (all eight items) | none | Observability, controller, worker, packaging script, Ansible |
| T8 | #860 stale account versus old image, #861 newer image published | none | Admin UI, API, worker |
| T9 | Fold into SPEC.md, STATUS.md, BACKLOG.md; delete this plan | removes the folded entries | Docs |

## Rulings carried from the issues

- `.portikus` ignore pattern: `.portikus/*`, `!.portikus/checks.json`,
  `!.portikus/README.md`. New projects get it in `.gitignore`; existing
  repositories get it in `.git/info/exclude`.
- Agent instructions: a template at `/usr/share/portikus/AGENTS.md` is copied
  once to `~/.codex/AGENTS.md`, and `~/.claude/CLAUDE.md` is created once as
  `@~/.codex/AGENTS.md`. Neither is ever overwritten. The template text holds
  no issue, pull request or SPEC references.
- The platform never commits, branches or tags in a student's repository
  (SPEC.md section 12.5). Setting the initial branch name at `git init` is
  allowed; nothing else is.

## Left out

#840 (Docker shared storage spike); #627, #753, #767, #799, #804 (each its own
epic); backlog entries on download sizes, replace-on-rename prompts, the
inotify watch limit and folders over 2,000 entries.

## After the tasks

Code review, security review (T1, T3, T4, T5 touch the agent and file APIs),
accessibility review (T2, T3, T4, T5, T8 touch `apps/web`), fixes as task PRs,
confirmation reviews, T9, then the epic pull request.
