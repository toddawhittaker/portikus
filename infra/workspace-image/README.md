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
