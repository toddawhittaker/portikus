#!/usr/bin/env bash
# Build the portikus control-plane Debian package (ADR 0007, SPEC.md Epic 3.5).
# Prints the package version as the last line of stdout.
set -euo pipefail

NFPM_VERSION="2.47.0"
NFPM_SHA256="0660ca602b2d2d2ae4781a06c692b3eeb9d437ffea05b831d76e41f4a3188783"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

version="${PORTIKUS_VERSION:-0.1.$(git rev-list --count HEAD)+g$(git rev-parse --short HEAD)}"

# Always use the pinned release, never whatever nfpm happens to be on PATH, so
# the package is reproducible. The cached tarball is re-checked on every run.
find_nfpm() {
	local cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/portikus/nfpm/$NFPM_VERSION"
	local tarball="nfpm_${NFPM_VERSION}_Linux_x86_64.tar.gz"
	local archive="$cache_dir/$tarball"
	local binary="$cache_dir/nfpm"

	if ! echo "${NFPM_SHA256}  $archive" | sha256sum -c --status - 2>/dev/null; then
		local url="https://github.com/goreleaser/nfpm/releases/download/v${NFPM_VERSION}/${tarball}"
		echo "Downloading nfpm ${NFPM_VERSION}..." >&2
		mkdir -p "$cache_dir"
		rm -f "$archive" "$binary"
		curl -fsSL "$url" -o "$archive"
		echo "${NFPM_SHA256}  $archive" | sha256sum -c - >&2
	fi

	if [ ! -x "$binary" ]; then
		tar -xzf "$archive" -C "$cache_dir" nfpm
	fi
	echo "$binary"
}

nfpm_bin="$(find_nfpm)"

pnpm install --frozen-lockfile
pnpm exec tsc -b

# Caddy serves this bundle from /usr/lib/portikus/web.
pnpm --filter @portikus/web build
chmod -R u=rwX,go=rX apps/web/dist

rm -rf dist/deploy dist/deb
pnpm --filter @portikus/api deploy --prod --legacy dist/deploy/api
pnpm --filter @portikus/worker deploy --prod --legacy dist/deploy/worker
pnpm --filter @portikus/workspace-controller deploy --prod --legacy dist/deploy/controller
# Runs inside each workspace container, bind-mounted read-only from
# /usr/lib/portikus/workspace-agent by the Incus workspace profile.
pnpm --filter @portikus/workspace-agent deploy --prod --legacy dist/deploy/workspace-agent

# pnpm deploy copies the whole package directory. Drop what the runtime never
# reads: TypeScript sources, tsconfigs, build caches, and the lockfile copies.
prune_tree() {
	local tree="$1"
	find "$tree" -name '*.tsbuildinfo' -delete
	rm -f "$tree/pnpm-lock.yaml" "$tree/pnpm-workspace.yaml" "$tree/tsconfig.json"
	rm -rf "$tree/src"
	find "$tree" -type d -path '*/@portikus/*' -name src -prune -exec rm -rf {} +
	find "$tree" -type f -path '*/@portikus/*' -name tsconfig.json -delete
	# Some dependencies ship type-test files; nothing at runtime reads .ts.
	find "$tree" -type f -name '*.ts' ! -name '*.d.ts' -delete
	# Never ship local secrets, registry credentials, tests, or source maps.
	find "$tree" -name '.env*' -prune -exec rm -rf {} +
	find "$tree" -type f \( -name '.npmrc' -o -name '*.test.js' \
		-o -name '*.test.d.ts' -o -name '*.js.map' -o -name '*.d.ts.map' \) -delete
	# The package ships read-only files owned by root.
	chmod -R u=rwX,go=rX "$tree"
}

for name in api worker controller workspace-agent; do
	prune_tree "dist/deploy/$name"
done

# systemd inside the container starts the agent through this shim, so the
# unit does not need to know where node lives or how the tree is laid out.
mkdir -p dist/deploy/workspace-agent/bin
cat > dist/deploy/workspace-agent/bin/workspace-agent <<'SHIM'
#!/bin/sh
exec /usr/bin/node /opt/portikus/workspace-agent/dist/index.js
SHIM
chmod 0755 dist/deploy/workspace-agent/bin dist/deploy/workspace-agent/bin/workspace-agent

mkdir -p dist/deb
echo "$version" > dist/deb/VERSION
PORTIKUS_VERSION="$version" "$nfpm_bin" package \
	--config packaging/nfpm.yaml \
	--packager deb \
	--target "dist/deb/portikus_${version}_amd64.deb"

echo "$version"
