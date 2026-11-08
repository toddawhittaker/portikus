#!/usr/bin/env bash
# Fail unless a deployed workspace-agent tree can run the chat tab: it has the
# Claude Agent SDK and the chat host, and none of the SDK's platform binaries,
# which are hundreds of MB each and unused because the SDK is pointed at the
# shared Claude Code (SPEC.md section 10.1).
# Usage: check-agent-tree.sh <tree>
set -euo pipefail

tree="${1:?Usage: check-agent-tree.sh <tree>}"

if [ ! -f "$tree/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs" ]; then
	echo "check-agent-tree: ${tree} lacks the Claude Agent SDK (sdk.mjs)" >&2
	exit 1
fi
if [ ! -f "$tree/dist/chat/main.js" ]; then
	echo "check-agent-tree: ${tree} lacks the chat host (dist/chat/main.js)" >&2
	exit 1
fi
# pnpm names the store folder @anthropic-ai+claude-agent-sdk-<platform>@<version>.
binaries="$(find "$tree" \( -type d -o -type l \) -name '*claude-agent-sdk-*' -print)"
if [ -n "$binaries" ]; then
	echo "check-agent-tree: ${tree} holds the SDK's platform binaries:" >&2
	echo "$binaries" >&2
	exit 1
fi
