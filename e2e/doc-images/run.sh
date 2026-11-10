#!/bin/sh
# make screenshots: build, then take the documentation images in docs/images
# from the end-to-end stack on a database of its own. Without
# TEST_DATABASE_URL it starts a throwaway PostgreSQL container and removes it
# afterwards, so it never touches a real database.
set -eu
cd "$(dirname "$0")/../.."

corepack pnpm build

if [ -z "${TEST_DATABASE_URL:-}" ]; then
	name="portikus-screenshots-pg-$$"
	docker run --rm -d --name "$name" -e POSTGRES_PASSWORD=portikus \
		-e POSTGRES_DB=portikus_test -p 127.0.0.1::5432 postgres:17 >/dev/null
	trap 'docker rm -f "$name" >/dev/null 2>&1' EXIT
	port=$(docker port "$name" 5432/tcp | head -n 1 | sed 's/.*://')
	until docker exec "$name" pg_isready -U postgres -q; do sleep 1; done
	sleep 2
	TEST_DATABASE_URL="postgres://postgres:portikus@127.0.0.1:$port/portikus_test"
	export TEST_DATABASE_URL
fi

node e2e/with-run-database.mjs --config e2e/doc-images/playwright.config.ts "$@"
