// One simulated student: a workspace, a presence socket, a terminal, a
// project with a file watcher, a preview, and a stand-in coding agent.
import { openSocket, request, sleep, waitFor } from "./http.mjs";

const SESSION_COOKIE = "__Host-portikus_session";
const PREVIEW_COOKIE = "__Host-portikus-preview";
// About the resident size of an idle coding agent CLI (docs/archive/epics/EPIC-12B.md, B4).
const STAND_IN =
	"(setsid nohup python3 -c 'import time; b = b\"x\" * (150 << 20); time.sleep(86400)' >/dev/null 2>&1 &)";

export class Student {
	constructor({ key, token, api, metrics, previewPort }) {
		this.key = key;
		this.api = api;
		this.metrics = metrics;
		this.previewPort = previewPort;
		this.cookie = `${SESSION_COOKIE}=${token}`;
		this.sockets = [];
		this.output = "";
		this.echoWaiters = new Set();
		this.fsWaiters = new Set();
		this.tick = 0;
	}

	// An API call through Caddy, timed under "api METHOD ROUTE".
	async call(
		method,
		path,
		route,
		{ body, type = "application/json", headers = {}, expect } = {},
	) {
		const all = { cookie: this.cookie, ...headers };
		if (method !== "GET") all.origin = this.api;
		if (body !== undefined) all["content-type"] = type;
		const res = await request(`${this.api}${path}`, { method, headers: all, body });
		const name = `api ${method} ${route}`;
		if (expect && !expect.includes(res.status)) {
			this.metrics.fail(name, `status ${res.status}`);
			throw new Error(
				`${method} ${route}: status ${res.status} ${res.body.slice(0, 200)}`,
			);
		}
		this.metrics.record(name, res.ms);
		return res;
	}

	json(res) {
		return JSON.parse(res.body);
	}

	// An error state ends the wait at once, with the workspace's own error.
	async state() {
		const res = await this.call("GET", `/workspaces/${this.id}`, "/workspaces/:id", {
			expect: [200],
		});
		const body = this.json(res);
		if (body.state === "error") {
			this.stateError = new Error(
				`${this.instance} error ${body.errorCode}: ${body.errorMessage}`,
			);
		}
		return body.state;
	}

	async waitForState(want, timeoutMs, everyMs) {
		this.stateError = null;
		await waitFor(
			want,
			async () => {
				const state = await this.state();
				if (this.stateError) return true;
				return state === want;
			},
			{ timeoutMs, everyMs },
		);
		if (this.stateError) throw this.stateError;
	}

	/** POST /workspaces and wait for the first provisioning to finish. */
	async provision() {
		const started = performance.now();
		const res = await this.call("POST", "/workspaces", "/workspaces", {
			expect: [201],
		});
		const body = this.json(res);
		this.id = body.id;
		this.instance = body.incusInstanceName;
		await this.waitForState("stopped", 600000, 1000);
		this.metrics.record("provision", performance.now() - started);
	}

	/**
	 * Opens the workspace the way a browser does, and times it until a terminal
	 * can be made: SPEC.md section 25.1, "stopped workspace ready for browser
	 * connection".
	 */
	async start() {
		const started = performance.now();
		const presence = await openSocket(
			`${this.api.replace(/^https/, "wss")}/workspaces/${this.id}/ws`,
			{
				origin: this.api,
				cookie: this.cookie,
			},
		);
		this.sockets.push(presence);
		presence.send(JSON.stringify({ type: "heartbeat" }));
		this.heartbeat = setInterval(
			() => presence.send(JSON.stringify({ type: "heartbeat" })),
			20000,
		);
		await this.waitForState("running", 600000, 250);
		const terminal = await waitFor(
			"terminal",
			async () => {
				const res = await request(`${this.api}/workspaces/${this.id}/terminals`, {
					method: "POST",
					headers: {
						cookie: this.cookie,
						origin: this.api,
						"content-type": "application/json",
					},
					body: "{}",
				});
				return res.status === 201 ? JSON.parse(res.body) : undefined;
			},
			{ timeoutMs: 120000 },
		);
		this.metrics.record("start", performance.now() - started);
		this.terminalId = terminal.id;
	}

	/** The terminal socket, a project, its watcher, the stand-in and a preview. */
	async setUp() {
		const wss = this.api.replace(/^https/, "wss");
		const headers = { origin: this.api, cookie: this.cookie };
		this.terminal = await openSocket(
			`${wss}/workspaces/${this.id}/terminals/${this.terminalId}/ws`,
			headers,
		);
		this.sockets.push(this.terminal);
		this.terminal.addEventListener("message", (event) => this.onOutput(event.data));

		const project = this.json(
			await this.call("POST", `/workspaces/${this.id}/projects`, "/projects", {
				body: JSON.stringify({ name: "Load Test", source: "new" }),
				expect: [201],
			}),
		);
		this.projectId = project.id;
		const events = await openSocket(
			`${wss}/workspaces/${this.id}/projects/${project.id}/events`,
			headers,
		);
		this.sockets.push(events);
		events.addEventListener("message", (event) => this.onEvent(event.data));

		const server = `(setsid nohup python3 -m http.server ${this.previewPort} --bind 0.0.0.0 >/dev/null 2>&1 &)`;
		this.terminal.send(
			JSON.stringify({
				type: "input",
				data: `cd ~/projects/${project.slug} && ${STAND_IN}; ${server}; clear\r`,
			}),
		);

		await waitFor(
			"listening",
			async () => {
				const res = await this.call(
					"GET",
					`/workspaces/${this.id}/listening`,
					"/listening",
					{ expect: [200] },
				);
				return JSON.stringify(this.json(res)).includes(`"port":${this.previewPort}`);
			},
			{ everyMs: 1000, timeoutMs: 60000 },
		);
		const grant = this.json(
			await this.call(
				"POST",
				`/workspaces/${this.id}/preview-grants`,
				"/preview-grants",
				{
					body: JSON.stringify({ port: this.previewPort, presentation: "top-level" }),
					expect: [201],
				},
			),
		);
		this.previewOrigin = grant.previewOrigin;
		const boot = await request(grant.bootstrapUrl, {
			headers: { "sec-fetch-dest": "document" },
		});
		const cookie = [boot.headers["set-cookie"] ?? []]
			.flat()
			.map((line) => line.split(";")[0])
			.find((pair) => pair.startsWith(`${PREVIEW_COOKIE}=`));
		if (boot.status !== 303 || !cookie)
			throw new Error(`preview bootstrap: status ${boot.status}, cookie ${!!cookie}`);
		this.previewCookie = cookie;
	}

	onOutput(data) {
		this.output = (
			this.output +
			(typeof data === "string" ? data : Buffer.from(data).toString("utf8"))
		).slice(-16384);
		for (const waiter of this.echoWaiters) {
			if (this.output.includes(waiter.token)) waiter.resolve();
		}
	}

	onEvent(data) {
		let event;
		try {
			event = JSON.parse(
				typeof data === "string" ? data : Buffer.from(data).toString("utf8"),
			);
		} catch {
			return;
		}
		if (event.type !== "fs") return;
		for (const waiter of this.fsWaiters) {
			if (event.truncated || event.paths.includes(waiter.path)) waiter.resolve();
		}
	}

	waiter(set, fields, timeoutMs, what) {
		let entry;
		const done = new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				set.delete(entry);
				reject(new Error(`${what}: none within ${timeoutMs} ms`));
			}, timeoutMs);
			entry = {
				...fields,
				resolve: () => {
					clearTimeout(timer);
					set.delete(entry);
					resolve(performance.now());
				},
			};
			set.add(entry);
		});
		return done;
	}

	/** One round of steady activity (docs/archive/epics/EPIC-12B.md, Part B decisions). */
	async act() {
		this.tick += 1;
		await this.measure("echo", async () => {
			// A shell comment, so the line does nothing when the next one clears it.
			const token = `#k${this.key}x${this.tick}q`;
			const echoed = this.waiter(this.echoWaiters, { token }, 5000, "echo");
			const sent = performance.now();
			this.terminal.send(JSON.stringify({ type: "input", data: token }));
			const at = await echoed;
			this.terminal.send(JSON.stringify({ type: "input", data: "\u0015" }));
			return at - sent;
		});

		let eventAt = null;
		await this.measure("file-event", async () => {
			const path = `load-${this.tick}.txt`;
			const seen = this.waiter(this.fsWaiters, { path }, 10000, "file event");
			const sent = performance.now();
			await this.call(
				"PUT",
				`/workspaces/${this.id}/projects/${this.projectId}/file?path=${path}`,
				"/file",
				{
					body: `tick ${this.tick}\n`,
					type: "text/plain",
					headers: { "if-none-match": "*" },
					expect: [200, 201],
				},
			);
			eventAt = await seen;
			return eventAt - sent;
		});

		if (eventAt !== null) {
			await this.measure("git-refresh", async () => {
				const res = await this.call(
					"GET",
					`/workspaces/${this.id}/projects/${this.projectId}/git/status`,
					"/git/status",
					{
						expect: [200],
					},
				);
				if (!this.json(res).repo)
					throw new Error("the project is not a Git repository");
				return performance.now() - eventAt;
			});
		}

		await this.measure("preview", async () => {
			const res = await request(`${this.previewOrigin}/`, {
				headers: { cookie: this.previewCookie },
			});
			if (res.status !== 200) throw new Error(`status ${res.status}`);
			return res.ms;
		});
	}

	async recoveryPoint() {
		await this.measure("recovery-point", async () => {
			const res = await this.call(
				"POST",
				`/workspaces/${this.id}/projects/${this.projectId}/recovery-points`,
				"/recovery-points",
				{ body: "{}", expect: [201] },
			);
			return res.ms;
		});
	}

	async measure(name, fn) {
		try {
			this.metrics.record(name, await fn());
		} catch (error) {
			this.metrics.fail(name, `${this.key} ${error.message}`);
		}
	}

	close() {
		clearInterval(this.heartbeat);
		for (const socket of this.sockets) socket.close();
	}
}

export { sleep };
