#!/usr/bin/env bash
# Checks that scripts/check-agent-tree.sh passes a workspace-agent tree with the
# SDK and the chat host, and fails one that lacks either or holds an SDK
# platform binary (SPEC.md section 10.1).
# Usage: packaging/tests/agent-tree-check-test.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
check="$root/scripts/check-agent-tree.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0

fresh_tree() {
	rm -rf "$work/tree"
	mkdir -p "$work/tree/dist/chat" "$work/tree/node_modules/@anthropic-ai/claude-agent-sdk"
	touch "$work/tree/dist/chat/main.js" "$work/tree/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"
}

expect() {
	local want="$1" name="$2" rc=0
	bash "$check" "$work/tree" >"$work/out" 2>&1 || rc=$?
	if { [ "$want" = pass ] && [ "$rc" -ne 0 ]; } || { [ "$want" = fail ] && [ "$rc" -eq 0 ]; }; then
		echo "FAIL: ${name} (exit ${rc})"
		cat "$work/out"
		failures=$((failures + 1))
	else
		echo "ok: ${name}"
	fi
}

fresh_tree
expect pass "a tree with the SDK and the chat host passes"

fresh_tree
rm "$work/tree/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"
expect fail "a tree without sdk.mjs fails"

fresh_tree
rm "$work/tree/dist/chat/main.js"
expect fail "a tree without the chat host fails"

fresh_tree
mkdir -p "$work/tree/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-x64@0.3.319"
expect fail "a pnpm store folder for a platform binary fails"

fresh_tree
mkdir -p "$work/tree/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64-musl"
expect fail "a hoisted platform package fails"

fresh_tree
mkdir -p "$work/elsewhere"
ln -s "$work/elsewhere" "$work/tree/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64"
expect fail "a link to a platform package fails"

fresh_tree
mkdir -p "$work/tree/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.319_zod@4.0.0"
expect pass "the SDK's own store folder is not a platform binary"

if [ "$failures" -ne 0 ]; then
	echo "${failures} check(s) failed"
	exit 1
fi
echo "agent tree check: all passed"
