import { generateKeyPairSync } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { jwtVerify } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
	fetchNrpsMembers,
	NRPS_MAX_MEMBERS,
	NRPS_MAX_PAGES,
	NRPS_SCOPE,
	NrpsError,
	type NrpsErrorKind,
	nextLink,
	requestNrpsToken,
} from "./nrps.js";

const tool = generateKeyPairSync("rsa", { modulusLength: 2048 });
const toolKeyPem = tool.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const ACCESS_TOKEN = "secret-access-token-0123456789";
const LEARNER = "http://purl.imsglobal.org/vocab/lis/v2/membership#Learner";
const INSTRUCTOR = "http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

/** A local HTTP server whose behaviour each test sets. */
async function startServer(): Promise<{
	server: Server;
	url: string;
	hits: string[];
	handle: (h: Handler) => void;
}> {
	let handler: Handler = (_req, res) => res.writeHead(404).end();
	const hits: string[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			hits.push(req.url ?? "");
			handler(req, res, body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		server,
		url: `http://127.0.0.1:${port}`,
		hits,
		handle: (h) => {
			handler = h;
		},
	};
}

let lms: Awaited<ReturnType<typeof startServer>>;
let elsewhere: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
	lms = await startServer();
	elsewhere = await startServer();
});

afterEach(() => {
	lms.hits.length = 0;
	elsewhere.hits.length = 0;
});

afterAll(async () => {
	for (const s of [lms, elsewhere]) {
		s.server.closeAllConnections();
		await new Promise((resolve) => s.server.close(resolve));
	}
});

function json(
	res: ServerResponse,
	value: unknown,
	headers: Record<string, string> = {},
) {
	res.writeHead(200, { "content-type": "application/json", ...headers });
	res.end(JSON.stringify(value));
}

async function failure(promise: Promise<unknown>): Promise<NrpsError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(NrpsError);
		return error as NrpsError;
	}
	throw new Error("expected a failure");
}

async function kindOf(promise: Promise<unknown>): Promise<NrpsErrorKind> {
	return (await failure(promise)).kind;
}

function token() {
	return requestNrpsToken({
		tokenUrl: `${lms.url}/token`,
		clientId: "client-1",
		toolKeyPem,
		kid: "tool-kid",
	});
}

function members(path = "/members") {
	return fetchNrpsMembers({
		membershipsUrl: `${lms.url}${path}`,
		accessToken: ACCESS_TOKEN,
	});
}

describe("requestNrpsToken", () => {
	test("posts a client assertion for the roster scope and returns the token", async () => {
		let form = new URLSearchParams();
		lms.handle((req, res, body) => {
			expect(req.method).toBe("POST");
			expect(req.headers["content-type"]).toBe("application/x-www-form-urlencoded");
			form = new URLSearchParams(body);
			json(res, { access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600 });
		});
		expect(await token()).toBe(ACCESS_TOKEN);
		expect(form.get("grant_type")).toBe("client_credentials");
		expect(form.get("scope")).toBe(NRPS_SCOPE);
		expect(form.get("client_assertion_type")).toBe(
			"urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
		);
		const { payload, protectedHeader } = await jwtVerify(
			form.get("client_assertion") ?? "",
			tool.publicKey,
			{
				algorithms: ["RS256"],
				issuer: "client-1",
				subject: "client-1",
				audience: `${lms.url}/token`,
			},
		);
		expect(protectedHeader.kid).toBe("tool-kid");
		expect(typeof payload.jti).toBe("string");
		expect(payload.exp).toBe((payload.iat ?? 0) + 300);
	});

	test.each<[string, Handler]>([
		["a refusal", (_req, res) => res.writeHead(401).end("nope")],
		["a body that is not JSON", (_req, res) => res.writeHead(200).end("<html>")],
		["no access token", (_req, res) => json(res, { token_type: "Bearer" })],
		[
			"an access token that is not a string",
			(_req, res) => json(res, { access_token: 7 }),
		],
		[
			"an oversized body",
			(_req, res) => json(res, { access_token: "a", pad: "x".repeat(70 * 1024) }),
		],
		[
			"a redirect",
			(_req, res) => res.writeHead(302, { location: `${elsewhere.url}/token` }).end(),
		],
	])("%s is token_failed", async (_label, handler) => {
		lms.handle(handler);
		expect(await kindOf(token())).toBe("token_failed");
		expect(elsewhere.hits).toEqual([]);
	});

	test("a refusal carries its status", async () => {
		lms.handle((_req, res) => res.writeHead(400).end());
		expect((await failure(token())).status).toBe(400);
	});

	test("an endpoint that does not answer is token_failed", async () => {
		const gone = await startServer();
		const url = `${gone.url}/token`;
		await new Promise((resolve) => gone.server.close(resolve));
		const error = await failure(
			requestNrpsToken({ tokenUrl: url, clientId: "c", toolKeyPem, kid: "k" }),
		);
		expect(error.kind).toBe("token_failed");
		expect(error.status).toBeNull();
	});
});

describe("fetchNrpsMembers", () => {
	test("follows next links, sends the bearer token and keeps only known fields", async () => {
		const auth: string[] = [];
		lms.handle((req, res) => {
			auth.push(req.headers.authorization ?? "");
			if (req.url === "/members") {
				json(
					res,
					{
						id: "x",
						context: { id: "ctx" },
						members: [
							{
								user_id: "u1",
								name: " Sam Student ",
								email: "sam@example.edu",
								picture: "https://pic",
								roles: [LEARNER],
								lis_person_sourcedid: "123",
							},
							{ user_id: "u2", roles: [INSTRUCTOR], status: "Inactive" },
						],
					},
					// Another link before the next one, and a relative next target.
					{ link: `<${lms.url}/members>; rel="first", </members?page=2>; rel="next"` },
				);
			} else {
				json(res, {
					members: [
						{ user_id: "u3", name: "", roles: [], status: "Deleted" },
						{ user_id: "u1", name: "Duplicate", roles: [INSTRUCTOR] },
					],
				});
			}
		});
		const result = await members();
		expect(lms.hits).toEqual(["/members", "/members?page=2"]);
		expect(auth).toEqual([`Bearer ${ACCESS_TOKEN}`, `Bearer ${ACCESS_TOKEN}`]);
		expect(result).toEqual([
			{
				userId: "u1",
				name: "Sam Student",
				roles: [LEARNER],
				role: "student",
				status: "Active",
			},
			{
				userId: "u2",
				name: null,
				roles: [INSTRUCTOR],
				role: "instructor",
				status: "Inactive",
			},
			{ userId: "u3", name: null, roles: [], role: "student", status: "Deleted" },
		]);
	});

	test("a very long name is cut to 255 characters", async () => {
		lms.handle((_req, res) =>
			json(res, { members: [{ user_id: "u1", name: "n".repeat(1000), roles: [] }] }),
		);
		expect((await members())[0]?.name).toHaveLength(255);
	});

	test("an empty roster is an empty list", async () => {
		lms.handle((_req, res) => json(res, { members: [] }));
		expect(await members()).toEqual([]);
	});

	test.each<[string, unknown]>([
		["no members field", { id: "x" }],
		["members that is not a list", { members: { u1: {} } }],
		["a member that is not an object", { members: ["u1"] }],
		["a numeric user id", { members: [{ user_id: 7, roles: [] }] }],
		["an empty user id", { members: [{ user_id: "", roles: [] }] }],
		["an overlong user id", { members: [{ user_id: "u".repeat(256), roles: [] }] }],
		["missing roles", { members: [{ user_id: "u1" }] }],
		["roles that are not strings", { members: [{ user_id: "u1", roles: [1] }] }],
		[
			"a name that is not a string",
			{ members: [{ user_id: "u1", name: {}, roles: [] }] },
		],
		[
			"an unknown status",
			{ members: [{ user_id: "u1", roles: [], status: "Banned" }] },
		],
		["a JSON null", null],
	])("%s is bad_shape", async (_label, body) => {
		lms.handle((_req, res) => json(res, body));
		expect(await kindOf(members())).toBe("bad_shape");
	});

	test("a body that is not JSON is bad_shape", async () => {
		lms.handle((_req, res) => res.writeHead(200).end("{not json"));
		expect(await kindOf(members())).toBe("bad_shape");
	});

	test("a bad second page fails the whole fetch", async () => {
		lms.handle((req, res) =>
			req.url === "/members"
				? json(
						res,
						{ members: [{ user_id: "u1", roles: [] }] },
						{ link: "</p2>; rel=next" },
					)
				: json(res, { members: "broken" }),
		);
		expect(await kindOf(members())).toBe("bad_shape");
	});

	test("an oversized body is cap_exceeded", async () => {
		lms.handle((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(`{"members":[],"pad":"${"x".repeat(5 * 1024 * 1024)}"}`);
		});
		expect(await kindOf(members())).toBe("cap_exceeded");
	});

	test(`endless paging stops at ${NRPS_MAX_PAGES} pages`, async () => {
		let n = 0;
		lms.handle((_req, res) => {
			n += 1;
			json(res, { members: [] }, { link: `</members?page=${n + 1}>; rel="next"` });
		});
		expect(await kindOf(members())).toBe("cap_exceeded");
		expect(lms.hits).toHaveLength(NRPS_MAX_PAGES);
	});

	test(`more than ${NRPS_MAX_MEMBERS} members is cap_exceeded`, async () => {
		const page = (start: number) =>
			Array.from({ length: 2600 }, (_, i) => ({ user_id: `u${start + i}`, roles: [] }));
		lms.handle((req, res) =>
			req.url === "/members"
				? json(res, { members: page(0) }, { link: "</p2>; rel=next" })
				: json(res, { members: page(2600) }),
		);
		expect(await kindOf(members())).toBe("cap_exceeded");
	});

	test("a next link to another host is refused before the token goes there", async () => {
		lms.handle((_req, res) =>
			json(res, { members: [] }, { link: `<${elsewhere.url}/steal>; rel="next"` }),
		);
		elsewhere.handle((_req, res) => json(res, { members: [] }));
		expect(await kindOf(members())).toBe("bad_shape");
		expect(elsewhere.hits).toEqual([]);
	});

	test("a redirect is not followed", async () => {
		lms.handle((_req, res) =>
			res.writeHead(302, { location: `${elsewhere.url}/steal` }).end(),
		);
		expect(await kindOf(members())).toBe("http_error");
		expect(elsewhere.hits).toEqual([]);
	});

	test("an error status is http_error with the status", async () => {
		lms.handle((_req, res) => res.writeHead(403).end("forbidden"));
		const error = await failure(members());
		expect(error.kind).toBe("http_error");
		expect(error.status).toBe(403);
	});

	test("a request that hangs is cut off after 10 seconds", async () => {
		lms.handle(() => {
			// Never answer.
		});
		const started = Date.now();
		const error = await failure(members());
		expect(error.kind).toBe("http_error");
		expect(error.status).toBeNull();
		expect(Date.now() - started).toBeLessThan(12_000);
	}, 15_000);
});

describe("nextLink", () => {
	const page = "https://lms.example.edu/members?page=1";
	test.each<[string | null, string | null]>([
		[null, null],
		["", null],
		[
			'<https://lms.example.edu/m?page=2>; rel="next"',
			"https://lms.example.edu/m?page=2",
		],
		["</m?page=2>; rel=next", "https://lms.example.edu/m?page=2"],
		['<https://a/1>; rel="prev", <https://a/3>; rel="next"', "https://a/3"],
		['<https://a/3>; rel="next last"', "https://a/3"],
		['<https://a/3>; REL="Next"', "https://a/3"],
		['<https://a/1>; rel="first"', null],
		["garbage", null],
	])("%s gives %s", (header, expected) => {
		expect(nextLink(header, page)).toBe(expected);
	});
});

describe("logging", () => {
	test("no token or member data reaches any log line or error", async () => {
		const written: string[] = [];
		const capture = (...args: unknown[]) => {
			written.push(args.map(String).join(" "));
			return true;
		};
		const spies = [
			vi.spyOn(console, "log").mockImplementation(capture),
			vi.spyOn(console, "info").mockImplementation(capture),
			vi.spyOn(console, "warn").mockImplementation(capture),
			vi.spyOn(console, "error").mockImplementation(capture),
			vi.spyOn(console, "debug").mockImplementation(capture),
			vi.spyOn(process.stdout, "write").mockImplementation(capture),
			vi.spyOn(process.stderr, "write").mockImplementation(capture),
		];
		const errors: NrpsError[] = [];
		try {
			lms.handle((req, res) => {
				if (req.url === "/token") {
					json(res, { access_token: ACCESS_TOKEN });
				} else if (req.url === "/members") {
					json(
						res,
						{
							members: [{ user_id: "secret-subject", name: "Secret Name", roles: [] }],
						},
						{ link: "</bad>; rel=next" },
					);
				} else {
					res.writeHead(500).end(`echo ${ACCESS_TOKEN} Secret Name`);
				}
			});
			expect(await token()).toBe(ACCESS_TOKEN);
			errors.push(await failure(members()));
			lms.handle((_req, res) =>
				json(res, {
					members: [{ user_id: "secret-subject", name: "Secret Name", roles: 1 }],
				}),
			);
			errors.push(await failure(members()));
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
		const text = [
			...written,
			...errors.map((e) => `${e.message} ${e.stack} ${JSON.stringify(e)}`),
		].join("\n");
		for (const secret of [ACCESS_TOKEN, "secret-subject", "Secret Name"]) {
			expect(text).not.toContain(secret);
		}
	});
});
