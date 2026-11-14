import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { AGENT_USAGE_PORT } from "@portikus/contracts";
import { createLogger } from "@portikus/observability";
import {
	CLAUDE_LIMITS_PATH,
	CODING_AGENT_STATE_PATH,
	CODING_AGENT_TITLE_PATH,
} from "../agent-usage.js";
import { chatHostArgs } from "../tmux.js";
import type { ClaudeLimitWindows } from "./claude-adapter.js";
import { CodexChatHost } from "./codex/host.js";
import { ChatHost } from "./host.js";
import { recordChatSession, takeSwapState } from "./session-record.js";
import { CHAT_SOCKET_DIR } from "./wire.js";

/**
 * `portikus-chat-host <terminal id> [--agent=codex] [<ended chat id>]`: the
 * command of a chat tab's tmux session, started in the project directory
 * (SPEC.md §10.2, §10.8). The flag runs Codex instead of Claude; the last
 * id names an ended chat this one resumes. Its log holds lifecycle events
 * and versions only (ADR 0012).
 */
const { terminalId, agent, resumeChatOf } = chatHostArgs(process.argv.slice(2));
// A swap to this agent, prepared by the host this one replaces, goes first:
// it points the session record at this agent's own session.
const swap = await takeSwapState(homedir(), terminalId, agent, resumeChatOf);
const sessionId = await recordChatSession(homedir(), terminalId, resumeChatOf);
const log = createLogger({
	service: "chat-host",
	level: "info",
	destination: process.stderr,
});
// The chat answers its own questions, so the terminal question hook skips
// the agent, which inherits the environment (ADR 0075).
process.env.PORTIKUS_CHAT_TAB = "1";
const receiver =
	process.env.PORTIKUS_AGENT_RECEIVER ?? `http://127.0.0.1:${AGENT_USAGE_PORT}`;

async function post(path: string, body: unknown): Promise<void> {
	const response = await fetch(`${receiver}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(1000),
	});
	if (!response.ok) throw new Error("refused");
}

const common = {
	terminalId,
	sessionId,
	projectDir: process.cwd(),
	homeDir: homedir(),
	socketDir: CHAT_SOCKET_DIR,
	log,
	swap,
	postTitle: (title: string | null) =>
		post(CODING_AGENT_TITLE_PATH, { terminal: terminalId, title }),
};

const host =
	agent === "codex"
		? new CodexChatHost({
				...common,
				// The receiver orders posts by time in microseconds, as the hooks send it.
				postState: (state) =>
					post(CODING_AGENT_STATE_PATH, {
						terminal: terminalId,
						agent: "codex",
						state,
						at: Date.now() * 1000,
					}),
			})
		: new ChatHost({
				...common,
				postLimits: (windows: ClaudeLimitWindows) => post(CLAUDE_LIMITS_PATH, windows),
			});

for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) {
	process.once(signal, () => {
		void host.stop().finally(() => process.exit(0));
	});
}

// The SDK version is pinned in this package's manifest; the Codex host logs
// the Codex version once app-server answers.
const manifest = JSON.parse(
	await readFile(new URL("../../package.json", import.meta.url), "utf8"),
) as { dependencies?: Record<string, string> };
log.info(
	{
		agent,
		...(agent === "claude"
			? { sdk: manifest.dependencies?.["@anthropic-ai/claude-agent-sdk"] }
			: {}),
		node: process.version,
	},
	"chat host starting",
);
await host.start();
