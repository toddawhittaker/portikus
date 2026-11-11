#!/bin/sh
# make screenshots: build, then take the documentation images in docs/images
# from the end-to-end stack on a database of its own. Without
# TEST_DATABASE_URL it starts a throwaway PostgreSQL container and removes it
# afterwards, so it never touches a real database.
set -eu
cd "$(dirname "$0")/../.."

# ImageMagick 7 installs only `magick`; older ones only `convert`.
if command -v magick >/dev/null 2>&1; then
	IMAGEMAGICK=magick
elif command -v convert >/dev/null 2>&1; then
	IMAGEMAGICK=convert
else
	echo "make screenshots needs ImageMagick (the magick or convert command)." >&2
	exit 1
fi
export IMAGEMAGICK

corepack pnpm build

if [ -z "${TEST_DATABASE_URL:-}" ]; then
	name="portikus-screenshots-pg-$$"
	docker run --rm -d --name "$name" -e POSTGRES_PASSWORD=portikus \
		-e POSTGRES_DB=portikus_test -p 127.0.0.1::5432 postgres:17@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f >/dev/null
	trap 'docker rm -f "$name" >/dev/null 2>&1' EXIT
	port=$(docker port "$name" 5432/tcp | head -n 1 | sed 's/.*://')
	until docker exec "$name" pg_isready -U postgres -q; do sleep 1; done
	sleep 2
	TEST_DATABASE_URL="postgres://postgres:portikus@127.0.0.1:$port/portikus_test"
	export TEST_DATABASE_URL
fi

node e2e/with-run-database.mjs --config e2e/doc-images/playwright.config.ts "$@"
