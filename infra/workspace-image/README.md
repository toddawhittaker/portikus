# Workspace Image

Distrobuilder definition for the Portikus student workspace (Debian trixie, container only).

Built with `distrobuilder build-incus portikus.yaml` on the platform VM.
The `VERSION` file holds the current image serial (e.g. `2026.09`).
Published images are aliased `portikus-<version>` and `portikus` (latest).

The build finishes with `apt-get update`, so the image carries the apt
package lists and the `command-not-found` database as of its build date. A
student can install a package straight away, and Debian's `apt-daily` timer
refreshes the lists inside a running workspace on its usual daily schedule.

The image installs a small clipboard shim at `/usr/local/bin/xclip`, with
`xsel` and `pbcopy` as symbolic links to it. A workspace has no X display, so
the shim reads what it is given and writes it to the terminal as an OSC 52
escape sequence, which tmux passes through to the browser.
Reading the clipboard is not possible, so `xclip -o` prints nothing.

The recipe takes two build parameters from the environment: the Node
major (24 or 26) and Python (Debian's alone, or with Python 3.14 from uv).
Unset, they give the pinned defaults CI publishes. The admin "rebuild" job
(`packaging/image/image-job`) sets them from its dropdowns. The comment at
the top of `portikus.yaml` lists them.

Claude Code and Codex are not in the image. They live on the server in
`/var/lib/portikus/coding-agents`, which every workspace mounts read-only at
`/opt/portikus/coding-agents`. The image carries only an empty mount point
and two links, `/usr/local/bin/claude` and `/usr/local/bin/codex`, to the
folder's `bin` links. Setup installs a pinned version of each, and the
admin page's **Update coding agents** job moves them to the newest release
without an image rebuild (docs/SPEC.md section 10).

## Playwright's headless Chromium

The image ships Playwright's `chromium-headless-shell` for one pinned
Playwright version, now **1.63.0** (browser build 1243), in
`/opt/ms-playwright`. The pin sits with the other pins at the top of
`portikus.yaml`; bump it with each image refresh, to the newest release that
is at least two weeks old. Only the headless shell is installed: no full
Chromium, Firefox or WebKit, and no global `playwright` package. Its system
libraries are their own package set in `portikus.yaml`, with one font family
(Liberation), because a page whose text has no font has no size and
Playwright then calls it hidden.

At login, `/etc/profile.d/portikus-playwright.sh` links the pinned build
into the student's own Playwright folder, `~/.cache/ms-playwright`, and adds
a `.links` entry so Playwright's cleanup keeps it. `PLAYWRIGHT_BROWSERS_PATH`
stays unset. A project on the pinned version needs no download:

```sh
npm init playwright@latest -- --quiet --no-browsers --lang=ts
npm install --save-dev --save-exact @playwright/test@1.63.0
npx playwright test --project=chromium
```

`npm init playwright` writes a `playwright.config.ts` with three projects:
chromium, firefox and webkit. The image has only Chromium, so delete the
firefox and webkit projects from that file (a course template should ship
without them). Do not run a plain `npx playwright install` to make them
work: it downloads every browser, several hundred megabytes, into the home
folder.

A project on any other Playwright version fails its first run with
Playwright's own "Executable doesn't exist" message. One command fixes it,
installing that version's headless shell into the student's home folder
(about 280 MB, kept across image rebuilds):

```sh
npx playwright install --only-shell chromium
```

Playwright launches Chromium with `--disable-dev-shm-usage`, so its shared
memory goes to `/tmp` (1 GB) rather than `/dev/shm` (256 MB). The workspace
smoke test launches the browser by hand without that switch, through
`/dev/shm`, and also through `playwright-core` at the pinned version.

`/tmp` is a memory-backed filesystem, so what Chromium keeps there counts
against the workspace's memory limit (4 GB by default), and the 1 GB cap is
a quarter of it. A full-page screenshot needs room in `/tmp` in proportion
to the page's area. Measured on the rehearsal VM with a 2-CPU, 4 GB
workspace, taking eight full-page screenshots 4000 pixels wide:

| Workers | Page height | `/tmp` peak | Result |
|---|---|---|---|
| 1 | 4000 | 130 MB | passes |
| 1 | 8000 | 323 MB | passes |
| 4 | 4000 | 510 MB | passes |
| 4 | 6000 | 1013 MB | passes, at the limit |
| 4 | 8000 | 1024 MB (full) | pages crash with "Target crashed" |

Ordinary course labs, with pages a screen or two tall, use a small part of
this. A lab that screenshots very tall pages should run one worker
(`workers: 1` in `playwright.config.ts`) or take screenshots of the visible
viewport rather than the full page. When `/tmp` fills, Chromium reports
"Target crashed", not "No space left on device", so check `df -h /tmp`
first when a lab's screenshots crash. The cap does not shrink with the
memory limit, so a workspace given much less than 4 GB can run out of
memory before `/tmp` is full. A course lab with a low workspace memory limit
should allow for the 1 GB `/tmp` plus the 256 MB `/dev/shm`, because both
count against memory.

The build checks the downloaded binary against a sha256 recorded beside the
pin in the step that installs it, so a pin bump needs both values.
