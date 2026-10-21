# 0066. Course profiles hide, stored on the LTI course

- **Status**: Accepted (Epic 52)
- **Date**: 2026-10-20
- **References**: SPEC.md sections 5.2, 8.7, 20.1, 24.11 and 26; VISION.md "Developer experience"; ADR 0057; issue #1246

## Context

A traditional programming course does not want the coding-agent launchers,
the Docker controls or the system process rows. An agentic course wants them.
The choice belongs to a course, and a student may be in several.

## Decision

1. **Two fixed profiles**, Agentic (the default) and Traditional. There are no
   per-feature switches.
2. **The profile only hides.** Traditional hides the Claude Code and Codex
   launchers, the Docker section of the workspace dialog and the system rows in
   the Running pane. The image, the egress rules and every API stay the same,
   and the Reset Docker action stays on the storage-full screen.
3. **It is stored on the LTI course**: `lti_contexts.profile`, a text column with
   a check constraint (migration 0050).
4. **Who counts.** Only a user's student memberships decide the profile, and the
   fullest wins. A user in no course, an instructor and an administrator see
   Agentic.
5. **Who sets it.** The course's instructor (checked against teaching that
   course) on the Course page, or an administrator on the Sign-in tab. Both
   call one function, and each change is audited as `course.profile_changed`
   in the same transaction.
6. **A site switch for code help**, `settings.code_help_enabled`, is separate. It
   is not part of the profile, and code help is on in both profiles (ADR 0065).

## Consequences

- A student's view can differ by course, and a change shows at the next page
  load or window focus.
- Hiding is not enforcement. A student can still run `claude` in a terminal.
  A course that needs a block has to ask for one, with egress rules or a
  different image.
- A profile on a course cannot cover a student who is in no course.
- Rejected: a profile per user (the instructor, not the student, should choose),
  per-feature switches (more settings than any course needs), and blocking
  tools (a larger change to the image and the egress rules than the need).
