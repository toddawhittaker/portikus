# 0063. Live help: a student invites one instructor to watch, and optionally type in, one project's terminals

- **Status**: Accepted (Epic 48)
- **Date**: 2026-10-12
- **References**: SPEC.md sections 5.2, 7.5, 9.7, 14.4, 20.2, 24.1, 24.7,
  24.11, 25.8 and 26; VISION.md non-goals; ADR 0012, ADR 0057; #1461,
  #1384, #1236

## Context

ADR 0057 lets a student share one project read-only with their
instructors. That shows files, not a running program. Students also want
help with what is happening in their terminal right now, and sometimes
want the instructor to type a command for them. Separately, a student
with one project open in two browsers saw each browser overwrite the
other's layout (#1384).

## Decision

1. **The student starts it, for one instructor.** Live help extends ADR
   0057's rule that the student shares. From a project's menu the student
   names one instructor, who must teach one of the student's courses; the
   API checks both the instructor and the student's membership. There is
   no request from the instructor's side. One open session per workspace
   (`live_help_sessions`, migration 0048), scoped to one project. A
   session lasts at most 60 minutes (`LIVE_HELP_MINUTES`).
2. **What the instructor gets.** The project's terminals, and previews of
   anything running in the student's workspace, because listeners carry
   no project; the consent text says so. Only the current screen and what
   follows: no scrollback. The instructor's listening list keeps the port
   and reachability and drops process and container details.
3. **View and type.** Typing is off at the start and only the student
   turns it on or off. The API enforces the mode: view drops every
   browser frame; type forwards `input` frames only, never `resize`. As a
   second layer the agent attaches with tmux's `-f read-only,ignore-size`
   or `-f ignore-size`. A mode change closes the instructor's sockets with
   4409, and the browser reattaches in the new mode. The instructor's
   terminal follows the student's size from a `size` frame.
4. **Typing is a full shell as the student, an accepted risk.** It
   reaches the student's Git, Claude and SSH credentials, every file and
   the other terminals. The consent dialog says this before Start, and
   the student can stop typing or end the session at any moment.
5. **Typing with consent is not takeover.** The VISION.md non-goal is now
   "takeover without the student's consent". Sessions are visible, opt-in
   and ended by the student at will.
6. **Gate.** Every instructor route and socket passes one check
   (`liveHelpScope`): the caller is the session's helper, the session is
   open and unexpired, the helper still shares a course with the student,
   and the project is active. Anything else, including another instructor
   of the same course and any administrator, gets 404.
7. **Presence.** Instructor sockets write no presence and never keep the
   workspace awake, and helper preview navigations record no activity.
   With no student browser open, the instructor's sockets close and new
   attaches get 409 `STUDENT_NOT_CONNECTED`; the session itself stays
   open until its limit, so an API restart does not end it.
8. **One instructor socket per terminal, newest wins.** A second socket
   on the same terminal closes the older one with 4411 ("opened in
   another tab") before it opens, so a sleeping laptop cannot lock the
   helper out. The replaced tab offers "Open here" and does not reconnect
   by itself.
9. **Ending.** The student's End, the instructor's Leave and an archive
   end it at once; expiry, sign-out and the instructor leaving the course
   within about a second. An end closes sockets with 4410, deletes the
   session's preview grants and sessions, clears the preview lookup cache
   and closes its bridge forwards. The reason is stored (`stopped`,
   `helper_left`, `archived`, `helper_removed`, `expired`) and the
   student's status shows it as `lastEnded` for 60 seconds.
10. **Audit and notice.** Start, end (with reason and duration), typing
    changes, each terminal opened (written before the pipe opens; a
    failed write refuses the attach) and each preview opened, with ids
    only. Expiry is stored but not audited, as with shares. The helper
    gets a notification on start.
11. **Instructor browser.** A separate minimal terminal, not the
    student's: no OSC 52 clipboard writes, no title changes, no image
    paste or voice, links open only on click with no opener. Student code
    in a preview runs in the instructor's browser on the preview origin,
    so administrators should teach from a separate instructor-only
    account until previews move to their own domain (#1236).
12. **Layout sync.** A project's layout carries a version. GET returns it
    as an ETag; PUT needs a matching `If-Match` and otherwise gets 412
    `LAYOUT_CHANGED`. After a save the API announces
    `{"type":"layout","projectId","version"}` on the owner's workspace
    sockets only, not on the per-project events socket, whose frames the
    agent could forge. A conflict is won by the server's layout. A remote
    load waits while a drag is in progress, keeps panes with unsaved
    text, keeps this browser's split sizes, and is never written back
    unless the user then changes something.

## Consequences

- An instructor can see and fix a running problem without a standing
  right to any student's terminal.
- A student who allows typing hands over their shell and credentials for
  the session.
- Previews reach the whole workspace, not only the project.
- Pane sizes stay per browser, and a losing browser's unsaved layout
  change is dropped.

## Rejected

- An instructor-side request to join: weaker consent for the same help.
- Several instructors in one session: no need yet.
- Scrollback replay: it shows output from before the student asked.
- Typing as a flag on the student's terminal component: the instructor's
  browser must drop features, not opt out of them one by one.
- Layout announcements on the per-project events socket: the agent can
  forge its frames.
