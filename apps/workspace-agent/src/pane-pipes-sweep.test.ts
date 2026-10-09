/**
 * The sweep of ended terminals races terminal creation: a listing that
 * started before a terminal existed must not stop that terminal's pipe.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { TmuxSession } from "./tmux.js";

let resolveListing: (sessions: TmuxSession[]) => void = () => undefined;

vi.mock("./tmux.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./tmux.js")>()),
	listSessions: () =>
		new Promise<TmuxSession[]>((resolve) => {
			resolveListing = resolve;
		}),
	pipePane: async () => undefined,
}));

const { PanePipes } = await import("./pane-pipes.js");

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pane-sweep-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

test("a terminal started while the listing is in flight survives the sweep", async () => {
	const ended = randomUUID();
	const fresh = randomUUID();
	const { logger, lines } = collectingLogger("debug");
	const pipes = new PanePipes({
		dir,
		server: { socketName: "unused", external: false },
		onClear: () => undefined,
		log: logger as unknown as FastifyBaseLogger,
		sweepMs: 60_000,
	});
	try {
		await pipes.start(ended);
		const sweep = pipes.sweep();
		await pipes.start(fresh);
		expect(lines.filter((line) => line.level === 40)).toEqual([]);
		expect(await exists(join(dir, fresh))).toBe(true);
		// The listing predates "fresh", so it names neither terminal.
		resolveListing([]);
		await sweep;
		await vi.waitFor(async () => expect(await exists(join(dir, ended))).toBe(false));
		expect(await exists(join(dir, fresh))).toBe(true);
	} finally {
		pipes.stopAll();
	}
});
