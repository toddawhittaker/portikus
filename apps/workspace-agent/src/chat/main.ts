import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { AGENT_USAGE_PORT, TerminalId } from "@portikus/contracts";
import { createLogger } from "@portikus/observability";
import { CLAUDE_LIMITS_PATH } from "../agent-usage.js";
import type { ClaudeLimitWindows } from "./claude-adapter.js";
import { ChatHost } from "./host.js";
import { CHAT_SOCKET_DIR } from "./wire.js";

/**
 * `portikus-chat-host <terminal id> [<session id>]`: the command of a chat
 * tab's tmux session, started in the project directory (SPEC.md §10.2,
 * §10.8). The session id names an ended chat this one resumes.
 * Its log holds lifecycle events and versions only (ADR 0012).
 */
const terminalId = TerminalId.parse(process.argv[2]);
const sessionId = TerminalId.optional().parse(process.argv[3]);
const log = createLogger({
	service: "chat-host",
	level: "info",
	destination: process.stderr,
});
const receiver =
	process.env.PORTIKUS_AGENT_RECEIVER ?? `http://127.0.0.1:${AGENT_USAGE_PORT}`;

const host = new ChatHost({
	terminalId,
	sessionId,
	projectDir: process.cwd(),
	homeDir: homedir(),
	socketDir: CHAT_SOCKET_DIR,
	log,
	postLimits: async (windows: ClaudeLimitWindows) => {
		await fetch(`${receiver}${CLAUDE_LIMITS_PATH}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(windows),
			signal: AbortSignal.timeout(1000),
		});
	},
});

for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) {
	process.once(signal, () => {
		void host.stop().finally(() => process.exit(0));
	});
}

// The SDK version is pinned in this package's manifest.
const manifest = JSON.parse(
	await readFile(new URL("../../package.json", import.meta.url), "utf8"),
) as { dependencies?: Record<string, string> };
log.info(
	{
		sdk: manifest.dependencies?.["@anthropic-ai/claude-agent-sdk"],
		node: process.version,
	},
	"chat host starting",
);
await host.start();
