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
escape sequence, which tmux passes through to the browser (issue #125).
Reading the clipboard is not possible, so `xclip -o` prints nothing.

To bump pinned tool versions, update the npm install action in `portikus.yaml`
and the comment block at the top of the file. Run `npm view <pkg> version`
to find the current release and record the date in the comment.
