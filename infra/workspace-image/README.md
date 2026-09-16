# Workspace Image

Distrobuilder definition for the Portikus student workspace (Debian trixie, container only).

Built with `distrobuilder build-incus portikus.yaml` on the platform VM.
The `VERSION` file holds the current image serial (e.g. `2026.09`).
Published images are aliased `portikus-<version>` and `portikus` (latest).

To bump pinned tool versions, update the npm install action in `portikus.yaml`
and the comment block at the top of the file. Run `npm view <pkg> version`
to find the current release and record the date in the comment.
