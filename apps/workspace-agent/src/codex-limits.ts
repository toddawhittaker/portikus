import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { AgentLimits, type AgentLimitWindow } from "./agent-limits-route.js";
import type { CodingAgentBoard } from "./coding-agent-status.js";

/** Longest a single `codex app-server` read may run before it is killed. */
const CODEX_READ_TIMEOUT_MS = 10_000;
/** Fewest milliseconds between two reads; each one calls chatgpt.com. */
export const CODEX_READ_INTERVAL_MS = 3 * 60_000;

const RATE_LIMITS_ID = 2;

export interface ReadCodexOptions {
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	now?: () => Date;
}

/** "5h" for 300 minutes, "7d" for 10080: hours under a day, else days. */
export function windowLabel(minutes: number): string {
	if (minutes < 1440) return `${Math.max(1, Math.round(minutes / 60))}h`;
	return `${Math.round(minutes / 1440)}d`;
}

function toWindow(raw: unknown): AgentLimitWindow | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { usedPercent, windowDurationMins, resetsAt } = raw as Record<string, unknown>;
	if (
		typeof usedPercent !== "number" ||
		typeof windowDurationMins !== "number" ||
		windowDurationMins <= 0 ||
		typeof resetsAt !== "number"
	) {
		return null;
	}
	return {
		name: windowLabel(windowDurationMins),
		usedPercent,
		resetsAt: new Date(resetsAt * 1000).toISOString(),
	};
}

/** Keep only the two windows' numbers from an `account/rateLimits/read` result. */
export function parseCodexRateLimits(result: unknown, now: Date): AgentLimits | null {
	if (typeof result !== "object" || result === null) return null;
	const rateLimits = (result as Record<string, unknown>).rateLimits;
	if (typeof rateLimits !== "object" || rateLimits === null) return null;
	const { primary, secondary } = rateLimits as Record<string, unknown>;
	const windows = [toWindow(primary), toWindow(secondary)].filter(
		(window): window is AgentLimitWindow => window !== null,
	);
	if (windows.length === 0) return null;
	const parsed = AgentLimits.safeParse({ windows, observedAt: now.toISOString() });
	return parsed.success ? parsed.data : null;
}

/**
 * One read through `codex app-server` over stdio. Any failure is null; the
 * reply is never logged, and only the window numbers leave this function
 * (ADR 0012). `account/read` is deliberately never called.
 */
export function readCodexLimitsOnce(
	options: ReadCodexOptions = {},
): Promise<AgentLimits | null> {
	const now = options.now ?? (() => new Date());
	return new Promise((resolve) => {
		let settled = false;
		const child = spawn("codex", ["app-server"], {
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "ignore"],
		});
		const finish = (limits: AgentLimits | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			lines.close();
			child.kill("SIGKILL");
			resolve(limits);
		};
		const timer = setTimeout(
			() => finish(null),
			options.timeoutMs ?? CODEX_READ_TIMEOUT_MS,
		);
		child.on("error", () => finish(null));
		child.on("exit", () => finish(null));
		child.stdin.on("error", () => finish(null));
		const lines = createInterface({ input: child.stdout });
		lines.on("line", (line) => {
			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			if (typeof message !== "object" || message === null) return;
			const { id, result } = message as Record<string, unknown>;
			if (id !== RATE_LIMITS_ID) return;
			finish(result === undefined ? null : parseCodexRateLimits(result, now()));
		});
		const send = (message: object): void => {
			child.stdin.write(`${JSON.stringify(message)}\n`);
		};
		send({
			method: "initialize",
			id: 1,
			params: { clientInfo: { name: "portikus", title: "Portikus", version: "0" } },
		});
		send({ method: "initialized" });
		send({ method: "account/rateLimits/read", id: RATE_LIMITS_ID });
	});
}

export interface CodexLimitsOptions {
	readOnce?: () => Promise<AgentLimits | null>;
	now?: () => number;
}

/**
 * Codex's plan limits, cached. A read is served from the cache at once and,
 * when the cache is stale, refreshes it in the background. At most one
 * reader runs at a time, and at most once every three minutes.
 */
export class CodexLimits {
	private cached: AgentLimits | null = null;
	private lastStartedAt: number | null = null;
	private running: Promise<void> | null = null;
	private readonly readOnce: () => Promise<AgentLimits | null>;
	private readonly now: () => number;

	constructor(options: CodexLimitsOptions = {}) {
		this.readOnce = options.readOnce ?? (() => readCodexLimitsOnce());
		this.now = options.now ?? Date.now;
	}

	/** The `AgentLimitsStore` codex reader. */
	read = async (): Promise<AgentLimits | null> => {
		this.refresh();
		return this.cached;
	};

	/** Start a read unless one is running or one started under three minutes ago. */
	refresh(): Promise<void> | null {
		if (this.running) return null;
		const at = this.now();
		if (
			this.lastStartedAt !== null &&
			at - this.lastStartedAt < CODEX_READ_INTERVAL_MS
		) {
			return null;
		}
		this.lastStartedAt = at;
		this.running = this.readOnce()
			.catch(() => null)
			.then((limits) => {
				this.cached = limits;
				this.running = null;
			});
		return this.running;
	}

	/** Refresh after any Codex terminal reports it finished a turn. */
	watch(board: CodingAgentBoard): () => void {
		return board.subscribe((terminals) => {
			if (terminals.some((t) => t.agent === "codex" && t.state === "finished")) {
				this.refresh();
			}
		});
	}
}
