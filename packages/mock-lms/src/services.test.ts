import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	decodeJwt,
	exportJWK,
	generateKeyPair,
	type JSONWebKeySet,
	SignJWT,
} from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NRPS_CLAIM, NRPS_SCOPE } from "./roster.js";
import { CLIENT_ID, DEPLOYMENT_ID, ROLE_URIS } from "./seed.js";
import { createHandler } from "./server.js";
import { createSigner } from "./token.js";

const ISSUER = "http://issuer.test";
const TOOL = "http://tool.test";
const LTI = "https://purl.imsglobal.org/spec/lti/claim/";
const DL = "https://purl.imsglobal.org/spec/lti-dl/claim/";
const NOW = 1_900_000_000;
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

type Key = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

let server: Server;
let base: string;
let toolKey: Key;
let strangerKey: Key;
let toolKeys: JSONWebKeySet;
let logs: string[];

beforeEach(async () => {
	logs = [];
	const pair = await generateKeyPair("RS256");
	toolKey = pair.privateKey;
	strangerKey = (await generateKeyPair("RS256")).privateKey;
	toolKeys = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "tool-1" }] };
	const handler = createHandler({
		issuer: ISSUER,
		toolUrl: TOOL,
		signer: await createSigner(),
		log: (line) => logs.push(line),
		now: () => NOW,
		fetchToolKeys: async () => toolKeys,
	});
	server = createServer((req, res) => void handler(req, res));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	await new Promise((resolve) => server.close(resolve));
});

function sign(claims: Record<string, unknown>, key: Key = toolKey) {
	return new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", kid: "tool-1" })
		.setExpirationTime(NOW + 300)
		.sign(key);
}

function assertion(over: Record<string, unknown> = {}, key: Key = toolKey) {
	return sign(
		{
			iss: CLIENT_ID,
			sub: CLIENT_ID,
			aud: `${ISSUER}/token`,
			jti: randomUUID(),
			...over,
		},
		key,
	);
}

async function post(path: string, fields: Record<string, string>) {
	return fetch(`${base}${path}`, { method: "POST", body: new URLSearchParams(fields) });
}

async function requestToken(clientAssertion: string, scope = NRPS_SCOPE) {
	return post("/token", {
		grant_type: "client_credentials",
		client_assertion_type: ASSERTION_TYPE,
		client_assertion: clientAssertion,
		scope,
	});
}

async function accessToken(): Promise<string> {
	const res = await requestToken(await assertion());
	return ((await res.json()) as { access_token: string }).access_token;
}

async function formToken(): Promise<string> {
	const html = await (await fetch(`${base}/`)).text();
	return /name="form_token" value="([^"]+)"/.exec(html)?.[1] as string;
}

async function changeRoster(fields: Record<string, string>) {
	return post("/roster", { form_token: await formToken(), ...fields });
}

interface Page {
	members: { user_id: string; roles: string[]; email?: string }[];
	context: { id: string };
}

async function memberships(url: string, token?: string) {
	return fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

async function roster(course = "mock-course-cs101", limit = 100): Promise<Page> {
	const res = await memberships(
		`${base}/nrps/${course}/memberships?limit=${limit}`,
		await accessToken(),
	);
	return (await res.json()) as Page;
}

describe("token endpoint", () => {
	it("issues a bearer token for a client assertion signed by the tool's key", async () => {
		const res = await requestToken(await assertion());
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			token_type: "Bearer",
			scope: NRPS_SCOPE,
			expires_in: 3600,
		});
		expect(logs.join("\n")).not.toMatch(/access_token|Bearer/);
	});

	it.each([
		["a signature from another key", () => assertion({}, strangerKey)],
		["the wrong audience", () => assertion({ aud: "http://elsewhere.test/token" })],
		["the wrong issuer", () => assertion({ iss: "someone-else" })],
		["the wrong subject", () => assertion({ sub: "someone-else" })],
		["no jti", () => assertion({ jti: undefined })],
		[
			"an expired assertion",
			() =>
				new SignJWT({
					iss: CLIENT_ID,
					sub: CLIENT_ID,
					aud: `${ISSUER}/token`,
					jti: "x",
				})
					.setProtectedHeader({ alg: "RS256", kid: "tool-1" })
					.setExpirationTime(NOW - 10)
					.sign(toolKey),
		],
		["garbage", async () => "not.a.jwt"],
	])("refuses %s", async (_label, make) => {
		const res = await requestToken(await make());
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "invalid_client" });
	});

	it("refuses a replayed assertion", async () => {
		const once = await assertion();
		expect((await requestToken(once)).status).toBe(200);
		expect((await requestToken(once)).status).toBe(401);
	});

	it("refuses another grant type, another assertion type and another scope", async () => {
		const wrongGrant = await post("/token", { grant_type: "password" });
		expect(wrongGrant.status).toBe(400);
		const wrongType = await post("/token", {
			grant_type: "client_credentials",
			client_assertion_type: "secret",
		});
		expect(wrongType.status).toBe(400);
		const wrongScope = await requestToken(await assertion(), "https://example.test/x");
		expect(wrongScope.status).toBe(400);
		expect(await wrongScope.json()).toEqual({ error: "invalid_scope" });
	});
});

describe("memberships endpoint", () => {
	it("needs a token the mock issued", async () => {
		const url = `${base}/nrps/mock-course-cs101/memberships`;
		expect((await memberships(url)).status).toBe(401);
		expect((await memberships(url, "made-up")).status).toBe(401);
	});

	it("is a 404 for an unknown course", async () => {
		const res = await memberships(`${base}/nrps/nope/memberships`, await accessToken());
		expect(res.status).toBe(404);
	});

	it("pages with Link rel=next until the last page", async () => {
		const token = await accessToken();
		const seen: string[] = [];
		let url: string | undefined = `${base}/nrps/mock-course-cs101/memberships?limit=3`;
		let pages = 0;
		while (url) {
			const res = await memberships(url, token);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("membershipcontainer");
			seen.push(...((await res.json()) as Page).members.map((m) => m.user_id));
			const next = /<([^>]+)>; rel="next"/.exec(res.headers.get("link") ?? "")?.[1];
			url = next?.replace(ISSUER, base);
			pages++;
		}
		expect(pages).toBe(3);
		expect(seen).toHaveLength(7);
		expect(new Set(seen).size).toBe(7);
	});

	it("lists roster-only people, and shares no email", async () => {
		const page = await roster();
		const rosa = page.members.find((m) => m.user_id.endsWith("2001"));
		expect(rosa?.roles).toEqual([ROLE_URIS.Learner]);
		expect(page.members.every((m) => m.email === undefined)).toBe(true);
		expect(page.members.find((m) => m.user_id.endsWith("1001"))?.roles).toEqual([
			ROLE_URIS.Instructor,
		]);
	});
});

describe("roster changes", () => {
	const dropme = (m: { user_id: string }) => m.user_id.endsWith("2003");

	it("drops, adds and changes a role", async () => {
		expect((await roster()).members.some(dropme)).toBe(true);
		expect(
			(await changeRoster({ action: "drop", course: "cs101", person: "dro" })).status,
		).toBe(204);
		expect((await roster()).members.some(dropme)).toBe(false);

		await changeRoster({
			action: "add",
			course: "cs101",
			person: "una",
			role: "Instructor",
		});
		const una = (await roster()).members.find((m) => m.user_id.endsWith("1602"));
		expect(una?.roles).toEqual([ROLE_URIS.Instructor]);

		await changeRoster({
			action: "role",
			course: "cs101",
			person: "sam",
			role: "TeachingAssistant",
		});
		const sam = (await roster()).members.find((m) => m.user_id.endsWith("1003"));
		expect(sam?.roles).toEqual([ROLE_URIS.TeachingAssistant]);
	});

	it("resets every roster", async () => {
		await changeRoster({ action: "drop", course: "cs101", person: "dro" });
		await changeRoster({ action: "reset" });
		expect((await roster()).members.some(dropme)).toBe(true);
	});

	it("refuses a change that names no one, and one without the form token", async () => {
		const bad = await changeRoster({
			action: "drop",
			course: "cs101",
			person: "nobody",
		});
		expect(bad.status).toBe(400);
		const badRole = await changeRoster({
			action: "role",
			course: "cs101",
			person: "sam",
			role: "King",
		});
		expect(badRole.status).toBe(400);
		const noToken = await post("/roster", { action: "reset" });
		expect(noToken.status).toBe(403);
	});
});

function hidden(html: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of html.matchAll(
		/<input type="hidden" name="([^"]+)" value="([^"]*)">/g,
	)) {
		out[m[1] as string] = (m[2] as string).replaceAll("&amp;", "&");
	}
	return out;
}

/** Runs the login and authorize steps; returns the id token the mock posts to the tool. */
async function idTokenFor(startPath: string, fields: Record<string, string>) {
	const started = await post(startPath, { form_token: await formToken(), ...fields });
	expect(started.status).toBe(200);
	const login = hidden(await started.text());
	const params = new URLSearchParams({
		scope: "openid",
		response_type: "id_token",
		response_mode: "form_post",
		client_id: CLIENT_ID,
		redirect_uri: `${TOOL}/lti/launch`,
		login_hint: login.login_hint as string,
		lti_message_hint: login.lti_message_hint as string,
		state: "s",
		nonce: "n",
	});
	const html = await (await fetch(`${base}/authorize?${params}`)).text();
	return { login, claims: decodeJwt(hidden(html).id_token as string) };
}

describe("launches", () => {
	it("carry the roster service claim on every kind of launch", async () => {
		const { claims } = await idTokenFor("/start", { person: "sam", course: "cs101" });
		expect(claims[NRPS_CLAIM]).toEqual({
			context_memberships_url: `${ISSUER}/nrps/mock-course-cs101/memberships`,
			service_versions: ["2.0"],
		});
		const dl = await idTokenFor("/deeplink/start", { person: "ivy", course: "cs240" });
		expect(dl.claims[NRPS_CLAIM]).toMatchObject({
			context_memberships_url: `${ISSUER}/nrps/mock-course-cs240/memberships`,
		});
	});
});

async function startDeepLink() {
	const { claims } = await idTokenFor("/deeplink/start", {
		person: "ivy",
		course: "cs101",
	});
	const settings = claims[`${DL}deep_linking_settings`] as {
		deep_link_return_url: string;
		data: string;
	};
	return { claims, settings };
}

function dlResponse(
	data: string,
	items: unknown,
	over: Record<string, unknown> = {},
	key: Key = toolKey,
) {
	return sign(
		{
			iss: CLIENT_ID,
			aud: ISSUER,
			nonce: "n",
			[`${LTI}message_type`]: "LtiDeepLinkingResponse",
			[`${LTI}version`]: "1.3.0",
			[`${LTI}deployment_id`]: DEPLOYMENT_ID,
			[`${DL}data`]: data,
			[`${DL}content_items`]: items,
			...over,
		},
		key,
	);
}

const ITEM = {
	type: "ltiResourceLink",
	title: "Project one",
	url: `${TOOL}/`,
	custom: { portikus_project: "project-one", portikus_template: "node-starter" },
};

describe("Deep Linking", () => {
	it("starts with a request carrying a return URL and data", async () => {
		const { claims, settings } = await startDeepLink();
		expect(claims[`${LTI}message_type`]).toBe("LtiDeepLinkingRequest");
		expect(claims[`${LTI}resource_link`]).toBeUndefined();
		expect(claims[`${LTI}roles`]).toEqual([ROLE_URIS.Instructor]);
		expect(settings.deep_link_return_url).toBe(`${ISSUER}/deeplink/return`);
		expect(settings.data).not.toBe("");
	});

	it("needs the form token to start", async () => {
		const res = await post("/deeplink/start", { person: "ivy", course: "cs101" });
		expect(res.status).toBe(403);
	});

	it("stores the signed items and launches one as a student with its custom parameters", async () => {
		const { settings } = await startDeepLink();
		const returned = await post("/deeplink/return", {
			JWT: await dlResponse(settings.data, [ITEM]),
		});
		expect(returned.status).toBe(200);
		expect(await returned.text()).toContain("Saved 1 link");

		const page = await (await fetch(`${base}/`)).text();
		const link = /<option value="([^"]+)">Project one \(cs101\)/.exec(page)?.[1];
		expect(link).toBeDefined();

		const { claims, login } = await idTokenFor("/launch-link", {
			link: link as string,
			person: "sam",
		});
		expect(login.target_link_uri).toBe(`${TOOL}/`);
		expect(claims[`${LTI}message_type`]).toBe("LtiResourceLinkRequest");
		expect(claims[`${LTI}roles`]).toEqual([ROLE_URIS.Learner]);
		expect(claims[`${LTI}context`]).toMatchObject({ id: "mock-course-cs101" });
		expect(claims[`${LTI}custom`]).toEqual({
			username: "sam.student",
			portikus_project: "project-one",
			portikus_template: "node-starter",
		});
		expect(claims[`${LTI}resource_link`]).toMatchObject({ id: link });
		expect(claims[NRPS_CLAIM]).toBeDefined();
	});

	it.each([
		[
			"a signature from another key",
			(d: string) => dlResponse(d, [ITEM], {}, strangerKey),
		],
		["the wrong audience", (d: string) => dlResponse(d, [ITEM], { aud: "other" })],
		[
			"the wrong message type",
			(d: string) =>
				dlResponse(d, [ITEM], { [`${LTI}message_type`]: "LtiResourceLinkRequest" }),
		],
		[
			"the wrong version",
			(d: string) => dlResponse(d, [ITEM], { [`${LTI}version`]: "1.1.0" }),
		],
		[
			"the wrong deployment",
			(d: string) => dlResponse(d, [ITEM], { [`${LTI}deployment_id`]: "x" }),
		],
		["unknown data", () => dlResponse("never-issued", [ITEM])],
		[
			"items that are not resource links",
			(d: string) => dlResponse(d, [{ type: "html", html: "<b>x</b>" }]),
		],
		["items that are not a list", (d: string) => dlResponse(d, "nope")],
		[
			"custom values that are not strings",
			(d: string) => dlResponse(d, [{ ...ITEM, custom: { a: 1 } }]),
		],
	])("refuses a response with %s and stores nothing", async (_label, make) => {
		const { settings } = await startDeepLink();
		const res = await post("/deeplink/return", { JWT: await make(settings.data) });
		expect(res.status).toBe(400);
		expect(await (await fetch(`${base}/`)).text()).toContain("No links saved yet");
	});

	it("refuses a launch of a link that was never saved", async () => {
		const res = await post("/launch-link", {
			form_token: await formToken(),
			link: "nope",
			person: "sam",
		});
		expect(res.status).toBe(400);
	});
});
