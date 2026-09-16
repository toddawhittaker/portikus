#!/usr/bin/env bash
# Build the portikus control-plane Debian package (ADR 0007, SPEC.md Epic 3.5).
# Prints the package version as the last line of stdout.
set -euo pipefail

NFPM_VERSION="2.47.0"
NFPM_SHA256="0660ca602b2d2d2ae4781a06c692b3eeb9d437ffea05b831d76e41f4a3188783"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

version="${PORTIKUS_VERSION:-0.1.$(git rev-list --count HEAD)+g$(git rev-parse --short HEAD)}"

# Prefer an nfpm on PATH; otherwise fetch the pinned release into the cache.
find_nfpm() {
	if command -v nfpm >/dev/null 2>&1; then
		command -v nfpm
		return
	fi
	local cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/portikus/nfpm"
	local binary="$cache_dir/$NFPM_VERSION/nfpm"
	if [ ! -x "$binary" ]; then
		local tarball="nfpm_${NFPM_VERSION}_Linux_x86_64.tar.gz"
		local url="https://github.com/goreleaser/nfpm/releases/download/v${NFPM_VERSION}/${tarball}"
		local tmp
		tmp="$(mktemp -d)"
		echo "Downloading nfpm ${NFPM_VERSION}..." >&2
		curl -fsSL "$url" -o "$tmp/$tarball"
		echo "${NFPM_SHA256}  $tmp/$tarball" | sha256sum -c - >&2
		mkdir -p "$cache_dir/$NFPM_VERSION"
		tar -xzf "$tmp/$tarball" -C "$cache_dir/$NFPM_VERSION" nfpm
		rm -rf "$tmp"
	fi
	echo "$binary"
}

nfpm_bin="$(find_nfpm)"

pnpm install --frozen-lockfile
pnpm build

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
}

for name in api worker controller; do
	prune_tree "dist/deploy/$name"
done

mkdir -p dist/deb
PORTIKUS_VERSION="$version" "$nfpm_bin" package \
	--config packaging/nfpm.yaml \
	--packager deb \
	--target "dist/deb/portikus_${version}_amd64.deb"

echo "$version"
