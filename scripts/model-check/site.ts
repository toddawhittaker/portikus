/**
 * A signed-in person on a Portikus site, as a browser would be: a cookie jar,
 * JSON requests with the site's Origin, and the assistant's WebSocket. Used
 * only by the model check (SPEC.md section 20.5, "Tested models").
 */

import { SESSION_COOKIE } from "../../packages/auth/src/types.ts";

export class Session {
	readonly base: string;
	private readonly cookies = new Map<string, string>();

	constructor(base: string) {
		this.base = base.replace(/\/$/, "");
	}

	/** A session from a token already in the database (the dry run's instructor). */
	static withToken(base: string, token: string): Session {
		const session = new Session(base);
		session.cookies.set(SESSION_COOKIE, token);
		return session;
	}

	cookieHeader(): string {
		return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
	}

	hasSession(): boolean {
		// An https site names it with the __Host- prefix (packages/auth sessionCookieName).
		return (
			this.cookies.has(SESSION_COOKIE) || this.cookies.has(`__Host-${SESSION_COOKIE}`)
		);
	}

	private keep(response: Response): void {
		for (const line of response.headers.getSetCookie()) {
			const [pair] = line.split(";");
			const at = pair?.indexOf("=") ?? -1;
			if (!pair || at < 1) continue;
			const name = pair.slice(0, at).trim();
			const value = pair.slice(at + 1).trim();
			if (value === "" || /max-age=0/i.test(line)) this.cookies.delete(name);
			else this.cookies.set(name, value);
		}
	}

	/** One request with no redirect following; keeps any cookies it sets. */
	async raw(url: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		if (this.cookies.size > 0) headers.set("cookie", this.cookieHeader());
		headers.set("origin", this.base);
		const response = await fetch(url, { ...init, headers, redirect: "manual" });
		this.keep(response);
		return response;
	}

	/** Follow redirects by hand, so every hop's cookies are kept. Returns the last response. */
	async follow(url: string, init: RequestInit = {}): Promise<Response> {
		let next = url;
		let options = init;
		for (let hop = 0; hop < 15; hop++) {
			const response = await this.raw(next, options);
			const location = response.headers.get("location");
			if (response.status < 300 || response.status >= 400 || !location) return response;
			await response.body?.cancel();
			next = new URL(location, next).href;
			options = {};
		}
		throw new Error("too many redirects");
	}

	/** A JSON request to the site; throws with the status and code on a failure. */
	async json<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await this.send(method, path, body);
		const text = await response.text();
		if (!response.ok) {
			const code = safeCode(text);
			throw new Error(
				`${method} ${path} answered ${response.status}${code ? ` ${code}` : ""}`,
			);
		}
		return (text ? JSON.parse(text) : null) as T;
	}

	/** The same request, answering the status instead of throwing. */
	async send(method: string, path: string, body?: unknown): Promise<Response> {
		return this.raw(`${this.base}${path}`, {
			method,
			...(body === undefined
				? {}
				: {
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					}),
		});
	}
}

/** Only the error code, never the message, which can echo input. */
function safeCode(text: string): string | null {
	try {
		const code = (JSON.parse(text) as { code?: unknown }).code;
		return typeof code === "string" ? code : null;
	} catch {
		return null;
	}
}

/**
 * The browser flow `make smoke-test` uses (infra/tests/smoke/sign-in.sh):
 * /auth/login to Dex, straight to its password form, post it, follow back
 * through the callback.
 */
export async function dexSignIn(
	base: string,
	login: string,
	password: string,
): Promise<Session> {
	const session = new Session(base);
	const start = await session.raw(`${session.base}/auth/login`);
	const dex = start.headers.get("location");
	if (!dex) throw new Error(`/auth/login answered ${start.status} with no redirect`);
	// Straight to Dex's own passwords when it also offers an upstream provider.
	const local = new URL(dex, session.base).href.replace(
		"/dex/auth?",
		"/dex/auth/local?",
	);
	const form = await session.follow(local);
	const page = await form.text();
	const action = /<form method="post" action="([^"]*)"/.exec(page)?.[1];
	if (!action) throw new Error(`no Dex password form (status ${form.status})`);
	await session.follow(
		new URL(action.replaceAll("&amp;", "&"), form.url || local).href,
		{
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ login, password }).toString(),
		},
	);
	if (!session.hasSession()) throw new Error("the Dex sign-in gave no session");
	return session;
}

/**
 * The end-to-end stack's mock provider (packages/auth testing): its authorize
 * page signs in whichever user the `user` parameter names.
 */
export async function mockSignIn(base: string, user: string): Promise<Session> {
	const session = new Session(base);
	const start = await session.raw(`${session.base}/auth/login`);
	const authorize = start.headers.get("location");
	if (!authorize)
		throw new Error(`/auth/login answered ${start.status} with no redirect`);
	await session.follow(`${authorize}&user=${encodeURIComponent(user)}`);
	if (!session.hasSession()) throw new Error("the mock sign-in gave no session");
	return session;
}

/** A wire event of the assistant's socket, with only the fields the check reads. */
export type WireEvent = {
	type: string;
	seq: number;
	id?: string;
	name?: string;
	input?: unknown;
	isError?: boolean;
	role?: string;
	markdown?: string;
	toolName?: string;
	confirmText?: string;
	status?: string;
};

/** How long one turn may take before the task fails. */
const TURN_TIMEOUT_MS = 180_000;
/** How long the socket must stay quiet after a turn ends; a Diagnose starts a second turn itself. */
const SETTLE_MS = 2_000;

/** One conversation's socket: every event it sent, and a way to wait for the turn to end. */
export class Conversation {
	readonly events: WireEvent[] = [];
	private readonly socket: WebSocket;
	private wake: (() => void) | null = null;

	private constructor(socket: WebSocket) {
		this.socket = socket;
		socket.addEventListener("message", (message) => {
			const event = JSON.parse(String(message.data)) as WireEvent;
			if (event.type !== "text.delta") this.events.push(event);
			this.wake?.();
		});
		socket.addEventListener("close", () => this.wake?.());
	}

	static open(session: Session, id: string): Promise<Conversation> {
		const url = `${session.base.replace(/^http/, "ws")}/assistant/conversations/${id}/socket`;
		// Node's WebSocket takes headers, which a browser's does not.
		const socket = new WebSocket(url, {
			headers: { cookie: session.cookieHeader(), origin: session.base },
		} as unknown as string[]);
		return new Promise((resolve, reject) => {
			socket.addEventListener("open", () => resolve(new Conversation(socket)), {
				once: true,
			});
			socket.addEventListener(
				"error",
				() => reject(new Error("the socket did not open")),
				{
					once: true,
				},
			);
		});
	}

	send(frame: unknown): void {
		this.socket.send(JSON.stringify(frame));
	}

	close(): void {
		this.socket.close();
	}

	/** Cards shown and not yet answered. */
	openCards(): WireEvent[] {
		const open = new Map<string, WireEvent>();
		for (const event of this.events) {
			if (event.type === "permission.requested" && event.id) open.set(event.id, event);
			if (event.type === "card.resolved" && event.id) open.delete(event.id);
		}
		return [...open.values()];
	}

	/** Wait until a turn has finished and nothing new arrives for a moment. */
	async settled(): Promise<void> {
		const deadline = Date.now() + TURN_TIMEOUT_MS;
		const finishedAt = () => {
			const last = this.events.at(-1);
			return last?.type === "turn.finished" ? this.events.length : null;
		};
		for (;;) {
			if (this.socket.readyState !== WebSocket.OPEN)
				throw new Error("the socket closed");
			if (Date.now() > deadline) throw new Error("the turn timed out");
			const mark = finishedAt();
			await this.next(mark === null ? deadline - Date.now() : SETTLE_MS);
			if (mark !== null && this.events.length === mark) return;
		}
	}

	private next(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.wake = null;
				resolve();
			};
			const timer = setTimeout(done, Math.max(ms, 0));
			this.wake = done;
		});
	}
}
