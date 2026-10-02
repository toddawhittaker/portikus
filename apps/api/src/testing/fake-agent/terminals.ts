import type { WebSocket } from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { FakeAgentState } from "./state.js";

/** Terminals and their attach sockets, like the agent's terminals.ts (SPEC.md §9). */
export function registerTerminalRoutes(app: FastifyInstance, s: FakeAgentState): void {
	const {
		flags,
		terminals,
		creates,
		attached,
		history,
		received,
		receivedByTerminal,
		buildOf,
		terminalsExit,
		keyOf,
	} = s;
	// The terminals unit's exit record, per workspace key (SPEC.md §9.7). A
	// test stages a restart: the record is written and the terminals are gone.
	// With `live`, open panes first get `exit` the way a dying unit ends them,
	// and the record lands `recordDelayMs` later, as ExecStopPost writes it.
	app.post("/__test/terminals-exit", async (request, reply) => {
		const body = request.body as {
			key?: string;
			result: string | null;
			at?: string;
			terminalId?: string;
			terminalIds?: string[];
			live?: boolean;
			recordDelayMs?: number;
		};
		if (body.result === null) {
			terminalsExit.delete(body.key ?? "");
			return reply.status(204).send();
		}
		const ids = [
			...(body.terminalIds ?? []),
			...(body.terminalId ? [body.terminalId] : []),
		];
		const at = body.at ?? new Date().toISOString();
		const record = { result: body.result, at };
		for (const id of ids) terminals.delete(id);
		if (body.live) {
			for (const id of ids) {
				for (const peer of attached.get(id) ?? []) {
					if (peer.readyState === peer.OPEN)
						peer.send(JSON.stringify({ type: "exit", serverGone: true }));
				}
			}
			const key = body.key ?? "";
			setTimeout(() => terminalsExit.set(key, record), body.recordDelayMs ?? 0);
		} else {
			terminalsExit.set(body.key ?? "", record);
		}
		return reply.status(204).send();
	});
	app.get("/terminals/last-exit", async (request) => {
		flags.lastExitHits += 1;
		return { exit: terminalsExit.get(keyOf(request)) ?? null };
	});

	// Send raw text frames to a terminal's attachments, as a misbehaving
	// agent might.
	app.post("/__test/terminals/:id/frames", async (request, reply) => {
		const id = (request.params as { id: string }).id;
		const body = request.body as { frames: string[] };
		for (const peer of attached.get(id) ?? []) {
			for (const frame of body.frames) {
				if (peer.readyState === peer.OPEN) peer.send(frame);
			}
		}
		return reply.status(204).send();
	});

	app.get("/terminals", async () => ({
		terminals: [...terminals].map(([id, value]) => ({
			id,
			cwd: value.cwd,
			attachments: 0,
		})),
	}));

	app.post("/terminals", async (request, reply) => {
		if (flags.failCreateWith) {
			const code = flags.failCreateWith;
			flags.failCreateWith = null;
			return reply
				.status(code === "INVALID_CWD" ? 400 : 500)
				.send({ error: { code, message: "create refused" } });
		}
		const body = request.body as {
			id: string;
			cwd: string;
			theme: string;
			timezone: string;
			agent?: string;
			institutionalEnv?: Record<string, string>;
		};
		creates.push(body);
		// The theme is kept so a test can check it reached here.
		terminals.set(body.id, {
			cwd: body.cwd,
			theme: body.theme,
			timezone: body.timezone,
			...(body.agent === undefined ? {} : { agent: body.agent }),
			...(body.institutionalEnv === undefined
				? {}
				: { institutionalEnv: body.institutionalEnv }),
		});
		return reply.status(201).send(flags.baselineReply);
	});

	app.delete("/terminals/:id", async (request, reply) => {
		const id = (request.params as { id: string }).id;
		if (!terminals.delete(id)) {
			return reply
				.status(404)
				.send({ error: { code: "TERMINAL_NOT_FOUND", message: "no such terminal" } });
		}
		return reply.status(204).send();
	});

	/** Send one line of output to every attachment, and remember it. */
	function emit(id: string, payload: string): void {
		const lines = history.get(id) ?? [];
		lines.push(payload);
		history.set(id, lines);
		for (const peer of attached.get(id) ?? []) {
			if (peer.readyState === peer.OPEN) {
				peer.send(Buffer.from(payload), { binary: true });
			}
		}
	}

	/**
	 * Every frame the fake has been sent with the terminal it arrived on, so a
	 * browser test can read its own terminal's frames. One fake agent serves
	 * every workspace in a run, so an unscoped list would mix the workers up.
	 */
	app.get("/__test/received", async () => ({ received: receivedByTerminal }));

	/** How many attachments the fake has for a terminal, so a test can wait. */
	app.get("/__test/terminals/:id/attachments", async (request) => {
		const id = (request.params as { id: string }).id;
		return { attachments: attached.get(id)?.size ?? 0 };
	});

	// Say a full-screen program has taken the terminal, or given it back, the
	// way the real agent does when it sees tmux's alternate screen.
	app.post("/__test/terminals/:id/screen", async (request, reply) => {
		const id = (request.params as { id: string }).id;
		const body = request.body as { alternate: boolean };
		for (const peer of attached.get(id) ?? []) {
			if (peer.readyState === peer.OPEN) {
				peer.send(JSON.stringify({ type: "screen", alternate: body.alternate }));
			}
		}
		return reply.status(204).send();
	});

	// Say the pane's history was erased, the way the real agent does after
	// `clear`.
	app.post("/__test/terminals/:id/clear", async (request, reply) => {
		const id = (request.params as { id: string }).id;
		for (const peer of attached.get(id) ?? []) {
			if (peer.readyState === peer.OPEN) peer.send(JSON.stringify({ type: "clear" }));
		}
		return reply.status(204).send();
	});

	// Restart the agent with a new build as an upgrade does: every attachment
	// of the terminal drops the way a stopping agent closes it, and the
	// browser's reconnect is told the new build.
	app.post("/__test/terminals/:id/agent-restart", async (request, reply) => {
		const id = (request.params as { id: string }).id;
		const body = request.body as { build: string };
		buildOf.set(id, body.build);
		for (const peer of attached.get(id) ?? []) peer.close(1001, "agent shutting down");
		return reply.status(204).send();
	});

	// Output a test wants on screen without typing for it, so a browser test
	// can fill the scrollback.
	app.post("/__test/terminals/:id/output", async (request, reply) => {
		const id = (request.params as { id: string }).id;
		const body = request.body as { lines: string[] };
		emit(id, `${body.lines.join("\r\n")}\r\n`);
		return reply.status(204).send();
	});

	app.get(
		"/terminals/:id/attach",
		{ websocket: true },
		(socket: WebSocket, request: FastifyRequest) => {
			const id = (request.params as { id: string }).id;
			if (!terminals.has(id)) {
				// After a staged restart, answer as the real agent does.
				if (terminalsExit.has(keyOf(request))) {
					socket.send(JSON.stringify({ type: "error", code: "TERMINAL_NOT_FOUND" }));
					socket.close(1008, "TERMINAL_NOT_FOUND");
					return;
				}
				socket.close(4404, "no such terminal");
				return;
			}
			flags.openAttachments += 1;
			const peers = attached.get(id) ?? new Set<WebSocket>();
			peers.add(socket);
			attached.set(id, peers);
			socket.on("close", () => {
				flags.openAttachments -= 1;
				peers.delete(socket);
			});
			const query = request.query as { cols?: string; rows?: string };
			// Earlier output first, then blank lines to push it into the
			// browser's scrollback, exactly as the real agent does.
			const earlier = history.get(id) ?? [];
			if (earlier.length > 0) {
				const rows = Number(query.rows ?? "24");
				const blank = "\r\n".repeat(Number.isFinite(rows) ? rows : 24);
				socket.send(Buffer.from(`${earlier.join("\r\n")}\r\n${blank}`), {
					binary: true,
				});
			}
			socket.send(JSON.stringify({ type: "size", cols: query.cols, rows: query.rows }));
			// Only once a test has staged a restart, so tests reading the
			// first frames are undisturbed.
			const build = buildOf.get(id);
			if (build) socket.send(JSON.stringify({ type: "agent", build }));
			socket.on("message", (data: Buffer) => {
				const text = data.toString();
				received.push(text);
				receivedByTerminal.push({ terminalId: id, text });
				const parsed = JSON.parse(text) as { type: string; cols?: number };
				if (parsed.type === "resize") {
					socket.send(JSON.stringify({ type: "size", cols: parsed.cols }));
					return;
				}
				const broadcast = (payload: string) => emit(id, payload);
				broadcast(`echo:${text}`);
				// A shell prints ^C when the interrupt byte reaches it, and the
				// clipboard tests need to see that Ctrl+C got through.
				const inputData = (parsed as { data?: unknown }).data;
				if (parsed.type === "input" && typeof inputData === "string") {
					if (inputData.includes("\u0003")) broadcast("^C");
					// A `cd` moves the terminal, which the real agent notices by
					// polling tmux and reports as a cwd frame (SPEC.md §9.3).
					const moved = /cd\s+(\S+)/.exec(inputData);
					if (moved?.[1]) {
						for (const peer of peers) {
							if (peer.readyState === peer.OPEN) {
								peer.send(JSON.stringify({ type: "cwd", path: moved[1] }));
							}
						}
					}
					// A shell runs in the zone the terminal was created with,
					// so `date` answers in that zone. The real
					// shell does this through TZ; the fake formats it here.
					if (/(^|\s)date(\s|$)/.test(inputData)) {
						const zone = terminals.get(id)?.timezone ?? "UTC";
						broadcast(
							new Date().toLocaleString("en-US", {
								timeZone: zone,
								timeZoneName: "short",
							}),
						);
					}
					// Ctrl+D ends the shell, and a shell that ends closes its pane.
					if (inputData.includes("\u0004")) {
						for (const peer of peers) {
							if (peer.readyState === peer.OPEN) {
								peer.send(JSON.stringify({ type: "exit", serverGone: false }));
							}
						}
					}
				}
			});
		},
	);
}
