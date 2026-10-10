# 0057. Instructors see a project only when the student shares it, and see agent usage as counts

- **Status**: Proposed (Epic 42)
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
   `.portikus/`.
4. **Audit and notice.** Share started, share stopped, and each
   instructor's first view per share are audited, not every read. The
   student sees a "Shared" badge, a notification on each first view, and a
   viewer list (`project_share_views`). No email or Pushover.
5. **A stopped workspace stays stopped.** The view says so, never starts
   it, and never counts as presence. The viewer polls every 10 seconds.
6. **Agent usage is counts only.** A receiver inside the workspace agent,
   on a fixed loopback port, takes OpenTelemetry metrics as JSON from
   Claude Code and Codex and keeps only allow-listed counters per UTC day,
   agent and model, capped at 50 models a day. The worker reads them every
   5 minutes into `agent_usage_days` (migration 0043), keyed by a boot id
   so a repeated read overwrites. No OpenTelemetry SDK. Kept 365 days.
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
- Codex appears only if its pinned version reports tokens through an
  allow-listable event with prompts off.

## Rejected

- Instructor-initiated viewing, or a per-course opt-in: weaker privacy for
  the same help.
- A student usage view, budgets, and a retention setting: no need yet.
