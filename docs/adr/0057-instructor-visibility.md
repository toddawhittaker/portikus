# 0057. Instructors see a project only when the student shares it, and see agent usage as counts

- **Status**: Accepted (Epic 42)
- **Date**: 2026-10-10
- **References**: SPEC.md sections 5.2, 10, 20.2, 24.1, 24.6, 24.11, 25.10
  and 26; STACK.md section 15; ADR 0012, ADR 0025

## Context

Instructors want to help a student with a project and to see how much the
class leans on coding agents. Students' files are private: other users and
administrators get 404 (SPEC.md 5.2).

## Decision

1. **The student shares, not the instructor.** "Share with my instructors"
   opens one project, read-only, to the instructors of every course the
   student belongs to. It ends after 24 hours or when the student stops
   it. One open share per project (`project_shares`, migration 0042).
   Administrators still get 404.
2. **What a share shows.** The file tree, text and image files, Git
   status, per-file diffs and the latest check results. Never terminals,
   previews, search, downloads, Docker, processes, or anything outside
   `~/projects/<slug>`.
3. **Secrets are filtered in the API** on tree, file, status and diff: any
   `.git` segment, `.env` and `.env.*` except `.env.example`, `*.pem`,
   `*.key`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc`, `.pypirc` and
   `.portikus/`. Shared reads also refuse any path with a symlink in any
   component (answered as missing), open files with `O_NOFOLLOW`, and
   leave symlinks out of tree listings and Git status. Shared check
   results carry each check's name and latest run, never its command,
   which may hold a secret.
4. **Audit and notice.** Share started, share stopped, and each
   instructor's first view per share are audited, not every read. The
   student sees a "Shared" badge, a notification on each first view, and a
   viewer list (`project_share_views`). No email or Pushover. Before a
   share starts, the dialog names its audience: each course the student
   belongs to and that course's instructors. A later view by the same
   instructor moves `last_viewed_at` at most once a minute. Archiving a
   project ends its share (`project.share_stopped`, reason `archived`).
5. **A stopped workspace stays stopped.** The view says so, never starts
   it, and never counts as presence. The viewer polls every 10 seconds.
6. **Agent usage is counts only.** A receiver inside the workspace agent,
   on a fixed loopback port, takes OpenTelemetry metrics as JSON from
   Claude Code and Codex and keeps only allow-listed counters per UTC day,
   agent and model, capped at 50 models a day. The worker reads them every
   5 minutes into `agent_usage_days` (migration 0043), keyed by a boot id
   so a repeated read overwrites. No OpenTelemetry SDK. Kept 365 days.
   - The receiver listens on `127.0.0.1:7401` in the container
     (`AGENT_USAGE_PORT`), next to the agent's 7400 and clear of the OTLP
     defaults 4317 and 4318 that a student's own tools may use. It takes
     `POST /v1/metrics` as JSON only, at most 1 MiB, and logs nothing. It
     runs in the agent process, so the Running pane hides it as a system
     listener.
   - Claude Code exports through managed settings: metrics only, `http/json`,
     delta temporality, logs and traces off, session and account ids off,
     no prompt or tool content flags. Kept: `claude_code.session.count`
     (not the `agents_view` dashboard), `claude_code.token.usage` by
     `type`, `claude_code.cost.usage` and `claude_code.lines_of_code.count`.
     The session count names no model, so it is kept under the model
     `(none)`.
   - Codex exports through the `[otel]` table of its system config:
     `metrics_exporter` to the receiver as JSON, the log and trace
     exporters off, `log_user_prompt = false`. This also stops Codex's
     default metrics export to OpenAI. Kept: `codex.thread.started` as
     sessions, and the sums of the `codex.turn.token_usage` histogram by
     `token_type`; Codex counts cache reads inside input, so they are
     subtracted. These are metrics, carrying only counts and the model,
     so no event is needed. Codex reports no cost and no lines changed.
   - Only delta points count, and the day is the receiver's UTC day on
     arrival, never the sender's timestamp. The agent keeps its last 40
     days in memory, so a report stays under its row cap.
   - Both settings files are rewritten by the controller at every start,
     but a student can still override them in their own config or post
     counts by hand.
   - Codex's `[otel]` table has no temporality key; its exporters default
     to delta, which the rehearsal VM confirms on a real Codex turn. Codex
     input is netted against cache reads when the agent reports, not per
     point.
   - The worker reads each workspace on its own, with a 5-second timeout,
     so one bad report never stops the others. It keeps only rows whose
     day is a real date within 40 days back and one day ahead, and at
     most 48 boot ids per user per day; a 49th boot that day is dropped
     with a warning that holds only counts. These bound what a forged
     report can store.
7. **Who sees usage.** Instructors see totals for their course members,
   including use outside that course; administrators see everyone, in an
   "Agent usage" admin tab. Sessions, tokens, lines changed, and Claude
   Code's "Estimated API cost". Students are told in Help.

## Consequences

- An instructor can help without a standing right to read student work.
- The filter is a deny list; a secret under another name is visible while
  shared.
- Usage counts come from the student's own agents and can be forged. They
  are for reporting, never enforcement.
- Codex is included: its token counts arrive as metrics carrying only
  counts and the model. Its delta temporality is a documented default,
  confirmed on the rehearsal VM.

## Rejected

- Instructor-initiated viewing, or a per-course opt-in: weaker privacy for
  the same help.
- A student usage view, budgets, and a retention setting: no need yet.
