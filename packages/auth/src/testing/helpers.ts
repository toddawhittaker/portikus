import * as crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { ServerMessage } from "@portikus/events";
import type { FastifyInstance } from "fastify";

/** Test-side glue: a cookie jar, a login driver, and a WebSocket opener. */

type SetCookieSource =
	| string
	| string[]
	| undefined
	| { headers: Headers }
	| { headers: Record<string, unknown> };

export class CookieJar {
	private readonly cookies = new Map<string, string>();

	/** Record cookies from a Fastify inject response, a fetch Response, or a raw header. */
	capture(source: SetCookieSource): void {
		for (const raw of toSetCookieList(source)) {
			const first = raw.split(";")[0] ?? "";
			const separator = first.indexOf("=");
			if (separator <= 0) {
				continue;
			}
			const name = first.slice(0, separator).trim();
			const value = first.slice(separator + 1).trim();
			if (value === "") {
				this.cookies.delete(name);
			} else {
				this.cookies.set(name, value);
			}
		}
	}

	get(name: string): string | undefined {
		return this.cookies.get(name);
	}

	cookieHeader(): string {
		return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
	}
}

function toSetCookieList(source: SetCookieSource): string[] {
	if (!source) {
		return [];
	}
	if (typeof source === "string") {
		return [source];
	}
	if (Array.isArray(source)) {
		return source;
	}
	const headers = source.headers;
	if (headers instanceof Headers) {
		return headers.getSetCookie();
	}
	const raw = (headers as Record<string, unknown>)["set-cookie"];
	if (typeof raw === "string") {
		return [raw];
	}
	return Array.isArray(raw) ? (raw as string[]) : [];
}

/**
 * Drive the whole login flow: the app's /auth/login, the mock provider's
 * consent page for the named user, and back through /auth/callback.
 */
export async function loginAs(
	app: FastifyInstance,
	user: string,
	jar: CookieJar,
): Promise<{ status: number; location: string | undefined }> {
	const start = await app.inject({
		method: "GET",
		url: "/auth/login",
		headers: { cookie: jar.cookieHeader() },
	});
	jar.capture(start);

	const authorizeUrl = start.headers.location;
	if (typeof authorizeUrl !== "string") {
		throw new Error(`GET /auth/login did not redirect (status ${start.statusCode})`);
	}

	const pick = new URL(authorizeUrl);
	pick.searchParams.set("user", user);
	const chosen = await fetch(pick, { redirect: "manual" });
	const callback = chosen.headers.get("location");
	if (!callback) {
		throw new Error(
			`the mock provider did not redirect back (status ${chosen.status})`,
		);
	}

	const callbackUrl = new URL(callback);
	const done = await app.inject({
		method: "GET",
		url: `${callbackUrl.pathname}${callbackUrl.search}`,
		headers: { cookie: jar.cookieHeader() },
	});
	jar.capture(done);

	const location = done.headers.location;
	return {
		status: done.statusCode,
		location: typeof location === "string" ? location : undefined,
	};
}

/** Headers that get a state-changing request past the CSRF check. */
export function csrfHeaders(jar: CookieJar, publicUrl: string): Record<string, string> {
	return {
		cookie: jar.cookieHeader(),
		origin: new URL(publicUrl).origin,
	};
}

export interface OpenSocket {
	ws: WebSocket;
	/** Every message received so far, JSON-parsed. */
	messages: ServerMessage[];
	next: () => Promise<ServerMessage>;
	/**
	 * The next message of one kind, skipping the others. The socket carries
	 * more than workspace updates, so a test that waits for a state change
	 * must say which frame it means.
	 */
	nextOf: <T extends ServerMessage["type"]>(
		type: T,
	) => Promise<Extract<ServerMessage, { type: T }>>;
	close: () => Promise<void>;
}

/**
 * Open the workspace WebSocket against a listening app. Rejects with
 * `{ status }` when the upgrade is refused, which is what the
 * authorization tests assert on.
 */
export async function openWorkspaceSocket(
	app: FastifyInstance,
	workspaceId: string,
	jar: CookieJar,
	publicUrl: string,
	overrides: Record<string, string> = {},
): Promise<OpenSocket> {
	const address = app.server.address() as AddressInfo | null;
	if (!address || typeof address === "string") {
		throw new Error("the app is not listening; call app.listen({ port: 0 }) first");
	}

	const path = `/workspaces/${workspaceId}/ws`;
	const headers: Record<string, string> = {
		origin: new URL(publicUrl).origin,
		cookie: jar.cookieHeader(),
		...overrides,
	};

	// Node's global WebSocket accepts request headers as a second argument.
	const ws = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, {
		headers,
	} as unknown as string[]);

	const messages: ServerMessage[] = [];
	const waiting: Array<(message: ServerMessage) => void> = [];
	let cursor = 0;

	ws.addEventListener("message", (event) => {
		const parsed = JSON.parse(String(event.data)) as ServerMessage;
		messages.push(parsed);
		waiting.shift()?.(parsed);
	});

	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener(
			"error",
			() => {
				// The WebSocket API hides the HTTP status, so ask the app what
				// it would have answered for the same upgrade request.
				app
					.inject({
						method: "GET",
						url: path,
						headers: {
							...headers,
							upgrade: "websocket",
							connection: "upgrade",
							"sec-websocket-version": "13",
							"sec-websocket-key": crypto.randomBytes(16).toString("base64"),
						},
					})
					.then((res) => reject({ status: res.statusCode }))
					.catch(() => reject({ status: 0 }));
			},
			{ once: true },
		);
	});

	const next = (): Promise<ServerMessage> =>
		new Promise<ServerMessage>((resolve) => {
			const pending = messages[cursor];
			if (pending !== undefined) {
				resolve(pending);
				cursor += 1;
				return;
			}
			waiting.push((message) => {
				cursor += 1;
				resolve(message);
			});
		});

	return {
		ws,
		messages,
		next,
		async nextOf<T extends ServerMessage["type"]>(type: T) {
			while (true) {
				const message = await next();
				if (message.type === type) {
					return message as Extract<ServerMessage, { type: T }>;
				}
			}
		},
		close: () =>
			new Promise<void>((resolve) => {
				if (ws.readyState === WebSocket.CLOSED) {
					resolve();
					return;
				}
				ws.addEventListener("close", () => resolve(), { once: true });
				ws.close();
			}),
	};
}
