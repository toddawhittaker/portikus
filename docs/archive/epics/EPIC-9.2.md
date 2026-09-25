# Epic 9.2 — Image paste into the terminal, and the rest of issue #300

Working brief for the epic after Epic 9.1. It is not in `docs/SPEC.md`
section 29 yet. Until that section exists, this file is the requirement
an agent implements against. Where this file is silent, `docs/SPEC.md`
still wins on behavior and `docs/STACK.md` still wins on technology.

## Where this epic sits

Epic 9.2 comes after Epic 9.1.

Epic 9 is on main (pull request 319). It covers coding-agent launchers,
credentials, the URL broker, and session review (`docs/SPEC.md` section
29, `docs/BROWSER-HANDLING.md` Part II). Epic 9.1 is the pilot-fix batch
on `epic/9-1-pilot-fixes`. Epics 10, 11, and 12 are recovery and quotas,
administration, and hardening.

Image paste is its own epic. It writes a file and changes what a paste
does in the terminal, which is a feature rather than a pilot fix.

## What the student gets

Pasting a picture into a terminal saves the picture in the selected
project and types that file's path into the shell, so Claude Code or
Codex can open it.

Today's paste reads clipboard text and types those characters into the
terminal (`apps/web/src/TerminalPane.tsx`, `paste`). A picture is saved
as a file. Its bytes are never typed into the terminal.

The paste the browser hands over is `image/png` or `image/jpeg`. That
includes Firefox, where `navigator.clipboard.readText` is refused and
the current code lets the browser's own paste through. Read the items
on the paste event. The clipboard never supplies the file name, even
when a name is attached to the item.

A paste that also contains text stays text, and is typed the way a
paste is typed today. A paste becomes a file only when it is a picture
of one of those two types and nothing else.

## Where the file goes

Portikus chooses the path, under the selected project:

```text
.portikus/pastes/2026-09-22T13-40-00.png
```

Use `.jpeg` when the type is `image/jpeg`. The timestamp comes from the
platform clock. Colons are written as hyphens so the name is one path
segment.

The terminal then receives the absolute path under the student's home,
a trailing space, and no newline:

```text
/home/student/projects/<slug>/.portikus/pastes/2026-09-22T13-40-00.png 
```

The trailing space leaves the student room to keep typing. With no
newline, the paste cannot run a command. The shell's working directory
may not be the project root, so a relative path would point at the
wrong place. Projects live at `~/projects/<slug>` (`docs/SPEC.md`
section 2.5). The workspace home is `/home/student` (`docs/SPEC.md`
section 4.4, `infra/workspace-image/portikus.yaml`).

The file belongs to the project the terminal was opened in, which
`TerminalPane` already receives as `projectId`. It does not follow the
shell's current directory.

## How to write the file

Use the existing project upload. There is no second write path.

- `PUT /workspaces/:id/projects/:pid/file?path=` with the relative path
  above (`apps/web/src/files/queries.ts`, `fileUrl` and `upload`).
- The body is the image bytes. The current upload sends
  `content-type: application/octet-stream` and `If-None-Match: *`, so
  the write creates a file and leaves an existing file alone
  (`docs/SPEC.md` sections 11.2 and 13.5).
- The cap is `MAX_UPLOAD_BYTES`, 50 MiB
  (`packages/contracts/src/files.ts`). A larger paste is refused the
  same way any other upload is refused.
- The same ownership checks apply. The route serves the workspace owner
  only (`docs/SPEC.md` section 11.6).
- The parent directory has to exist before the write, and `mkdir`
  requires its own parent to exist (`apps/workspace-agent/src/files.ts`,
  `docs/SPEC.md` section 11.2). Create `.portikus` when it is missing,
  then `.portikus/pastes`, then write the file. `.portikus` is already
  the directory that holds `.portikus/checks.json`.

Image bytes stay out of the logs (`docs/STACK.md` section 15,
`docs/SPEC.md` section 24). The platform already keeps terminal bytes,
prompts, and project source out of the logs.

## Also in this epic: the rest of issue #300

Epic 9.1 moved the Appearance choice into the Settings dialog but
left two parts of issue #300 unbuilt. Both belong to this epic. They
are independent of image paste and can go to a separate builder.
Context: `docs/SPEC.md` section 13.5 (per-user preferences), issues
#239, #268, #288, #300; `apps/web/src/settings/SettingsDialog.tsx`,
`apps/web/src/shell/theme.ts`, `apps/api/src/routes/me.ts`,
`packages/contracts/src/settings.ts`, `packages/db`.

### Appearance follows the student

Today the light / dark / system choice in the Appearance section is
kept only in this browser's localStorage under `pk-theme`. A student
who signs in from another browser or machine gets the default again.

Store the choice in the per-user settings row so it follows the
student. Keep the localStorage value as the pre-login default and as a
cache, so the first paint does not flash before the settings load.
When the saved setting arrives, it wins and refreshes the cache. The
terminal default theme stays in the Terminal section; do not merge the
two. Add appearance to the preference list in `docs/SPEC.md` section
13.5 in the same pull request.

### Profile section

A "Profile" section at the top of the Settings dialog shows what
Portikus knows about the student and lets them add a little. The
Account section that exists today shows only the institution sign-in;
fold it into Profile rather than keeping both.

Read-only, with a note that they come from the institution sign-in:
display name and email from the identity provider, and the workspace
label. Editable and optional: a profile picture, uploaded through the
existing file-upload machinery and stored on the users row as a small
image, shown in the account menu button in place of the initials; a
GitHub username or profile link; and one personal site link. Links
are validated as https URLs or bare usernames and rendered only as
plain anchors with `rel="noopener"`. Nothing in this section is used
for authorization. The profile columns need a migration in
`packages/db`; the orchestrator assigns its number at dispatch. Add
the profile fields to `docs/SPEC.md` section 13.5 in the same pull
request.

### Done for these two

1. Unit tests cover the settings merge and both sections.
2. A Playwright test sets appearance, opens a fresh browser context,
   signs in, and finds the choice applied without a flash to the
   default.
3. A Playwright test saves a profile link and sees it shown as a plain
   anchor; an invalid link is refused.
4. A profile picture upload over the existing cap is refused, and the
   picture shows in the account menu button once saved.

## Out of this epic

A public URL, optical character recognition, and submitting the path
are out of this epic. The path itself is what Claude Code and Codex
open. The typed text ends in a space.

Other clipboard types stay on the text paste that exists today. A gif,
a webp, or any type other than `image/png` and `image/jpeg` is not part
of this epic.

## Done

Tests pin the invariants below. The text paste that already shipped
still lands once: Ctrl+V, Ctrl+Shift+V, and a right-click with nothing
selected (`e2e/clipboard.spec.ts`, `apps/web/src/TerminalPane.tsx`).
Keyboard paste and the context-menu handler in that file are the two
places a paste enters the terminal today.

1. Pasting a png or a jpeg writes the file under the selected project's
   `.portikus/pastes/` with a name Portikus chose, and types the
   absolute home path, a trailing space, and nothing else. The image
   bytes never reach the terminal.
2. A paste that contains text is typed as text, including when an image
   sits on the clipboard beside the text.
3. The same image paste works where `readText` is refused, including
   Firefox.
4. An image over 50 MiB is refused by the existing upload cap.
5. The write stays inside the selected project, and only that
   workspace's owner can perform it.
6. Image bytes do not appear in platform logs.
