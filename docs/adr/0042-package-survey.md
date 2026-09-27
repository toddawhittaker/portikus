# 0042. The package survey and the reinstall note

- **Status**: Proposed
- **Date**: 2026-09-27
- **References**: SPEC.md sections 20.1 and 22.3, issue #626

## Context

A workspace rebuild replaces the system disk, so every package a student added with `sudo apt install` is lost, while the home folder survives. Those installs are also the best evidence of what the base image is missing. Administrators may see aggregate figures about workspaces, but not one student's environment (SPEC.md section 20.1), so a per-student list of added packages must never be stored.

## Decision

**One list per workspace, written by the image.** An apt hook in the image (`DPkg::Post-Invoke`) writes `~/.portikus/apt-packages.txt` after every apt run: a first line `# portikus-image: <version>`, then the packages the student marked manual that are not in the image's own list. The hook writes as the student, through a temporary file and a rename, so a symbolic link planted at the path gains nothing. While the file's header names an image other than the running one (after a rebuild, until the student dismisses the reinstall note), the hook keeps that header and adds the new packages to the old list, so an apt run after a rebuild does not wipe the record of what to put back. The same file serves the survey and the reinstall note. The apt history log is not read: rotated logs miss older installs, and the manual list already says what the student asked for.

**The survey stores counts only.** Once per UTC day, for each running workspace, the worker reads the file through the controller (`GET /instances/:name/added-packages`: a regular file of at most 64 KiB, each line checked against Debian's package-name form) and adds one to each listed package's count for that day. Two tables hold `(day, workspaces surveyed)` and `(day, package, workspaces)`. The only per-workspace column is `workspaces.package_surveyed_on`, the date it was last read, which a conditional update also uses so a workspace is never counted twice on one day. A workspace with no readable file (an image without the hook, or a file the controller refuses) is marked for the day but not counted. Counts are kept for 90 days.

**The admin table.** Only days that surveyed at least 3 workspaces are shown, so a count cannot single out one student; when no kept day has 3, the response has no rows, and `day` and `surveyed` give the latest day and its count, so the page can say why. `GET /admin/packages` lists every package seen in the kept days with the latest day's count, its first and last day seen, and whether it is a base-image candidate: added by at least 2 workspaces and at least a third of those surveyed that day. At most 200 rows are returned, most-added first. The Health tab shows it as "Packages students add".

**The reinstall note.** The workspace agent compares the file's image with `/etc/portikus-image-version`. When both are known and differ, the packages in the file that dpkg does not record as installed are the note, served by the agent at `GET /packages/reinstall-note` and passed through the API to the owner only. The browser shows them with a copyable `sudo apt install …` line; names are checked against the package-name pattern before they are shown or put on that line. Dismiss rewrites the header to the running image, through the agent, so the note does not return. Installing the packages again also clears it, because the hook rewrites the header.

## Consequences

- No table, log line or response pairs a workspace or student with a package name. A per-student view would need a ruling and a spec change.
- The survey needs nothing to run inside a workspace from outside: the controller reads one file through the Incus file API.
- A student can edit their own file, which changes only their own one count, and their own note.
- A workspace that never ran apt on a hooked image has no file, so it is not counted in the denominator for that day.
- The latest day's figures build up through the day as workspaces run, so early in a UTC day the denominator is small.
- The agent and the controller read the list with one parser, `parseAptList` in `packages/contracts`.
