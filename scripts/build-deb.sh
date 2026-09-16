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

# Only the server code is packaged; the web bundle is not shipped in this deb.
pnpm install --frozen-lockfile
pnpm exec tsc -b

rm -rf dist/deploy dist/deb
pnpm --filter @portikus/api deploy --prod --legacy dist/deploy/api
pnpm --filter @portikus/worker deploy --prod --legacy dist/deploy/worker
pnpm --filter @portikus/workspace-controller deploy --prod --legacy dist/deploy/controller

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

for name in api worker controller; do
	prune_tree "dist/deploy/$name"
done

mkdir -p dist/deb
echo "$version" > dist/deb/VERSION
PORTIKUS_VERSION="$version" "$nfpm_bin" package \
	--config packaging/nfpm.yaml \
	--packager deb \
	--target "dist/deb/portikus_${version}_amd64.deb"

echo "$version"
