import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "./cli.js";
import { escapeHtml } from "./pages.js";
import { CLIENT_ID, DEPLOYMENT_ID, PEOPLE, ROLE_URIS } from "./seed.js";
import { createHandler, registration } from "./server.js";
import { createSigner, DEFECTS, type Signer } from "./token.js";

const TOOL = "http://tool.test";
const LTI = "https://purl.imsglobal.org/spec/lti/claim/";
const NOW = 1_900_000_000;

let server: Server;
let base: string;
let signer: Signer;
let logs: string[];
let clock: number;

beforeEach(async () => {
	signer = await createSigner();
	logs = [];
	clock = NOW;
	server = createServer((req, res) => {
		void handler(req, res);
	});
	const handler = createHandler({
		issuer: "http://issuer.test",
		toolUrl: TOOL,
		signer,
		log: (line) => logs.push(line),
		now: () => clock,
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	await new Promise((resolve) => server.close(resolve));
});

function hiddenFields(html: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const m of html.matchAll(
		/<input type="hidden" name="([^"]+)" value="([^"]*)">/g,
	)) {
		fields[m[1] as string] = (m[2] as string).replaceAll("&amp;", "&");
	}
	return fields;
}

async function formToken(): Promise<string> {
	const html = await (await fetch(`${base}/`)).text();
	return hiddenFields(html).form_token as string;
}

async function start(form: Record<string, string>) {
	const res = await fetch(`${base}/start`, {
		method: "POST",
		body: new URLSearchParams({ form_token: await formToken(), ...form }),
	});
	return { status: res.status, html: await res.text() };
}

async function loginFor(form: Record<string, string>) {
	const { html } = await start(form);
	expect(html).toContain(`action="${TOOL}/lti/login"`);
	return hiddenFields(html);
}

function authorizeParams(
	login: Record<string, string>,
	extra: Record<string, string> = {},
) {
	return new URLSearchParams({
		scope: "openid",
		response_type: "id_token",
		response_mode: "form_post",
		prompt: "none",
		client_id: CLIENT_ID,
		redirect_uri: `${TOOL}/lti/launch`,
		login_hint: login.login_hint as string,
		lti_message_hint: login.lti_message_hint as string,
		state: "state-1",
		nonce: "nonce-1",
		...extra,
	});
}

async function authorize(params: URLSearchParams) {
	const res = await fetch(`${base}/authorize?${params}`);
	return { status: res.status, html: await res.text() };
}

async function launchToken(
	form: Record<string, string>,
	extra: Record<string, string> = {},
) {
	const login = await loginFor(form);
	const { status, html } = await authorize(authorizeParams(login, extra));
	expect(status).toBe(200);
	expect(html).toContain(`action="${TOOL}/lti/launch"`);
	return hiddenFields(html);
}

const verifyGood = (token: string) =>
	jwtVerify(token, createLocalJWKSet(signer.jwks), {
		issuer: "http://issuer.test",
		audience: CLIENT_ID,
		currentDate: new Date(NOW * 1000),
	});

describe("mock LMS", () => {
	it("serves the launch page with every person, course and defect", async () => {
		const res = await fetch(`${base}/`);
		const html = await res.text();
		expect(res.status).toBe(200);
		expect(html).toContain("CS 101 Intro to Programming");
		expect(html).toContain("CS 240 Data Structures");
		for (const p of PEOPLE) expect(html).toContain(`value="${p.key}"`);
		for (const d of DEFECTS) expect(html).toContain(`value="${d}"`);
		expect(html).toContain('<label for="person">');
	});

	it("serves one public RSA key at the JWKS URL", async () => {
		const res = await fetch(`${base}/.well-known/jwks.json`);
		const jwks = (await res.json()) as { keys: Record<string, string>[] };
		expect(jwks.keys).toHaveLength(1);
		expect(jwks.keys[0]).toMatchObject({ kty: "RSA", alg: "RS256", kid: signer.kid });
		expect(jwks.keys[0]).not.toHaveProperty("d");
	});

	it("makes a new key every run", async () => {
		const other = await createSigner();
		expect(other.kid).not.toBe(signer.kid);
		expect(other.jwks.keys[0]?.n).not.toBe(signer.jwks.keys[0]?.n);
	});

	it("starts third-party login with the initiation parameters", async () => {
		const login = await loginFor({ person: "sam", course: "cs101" });
		expect(login).toMatchObject({
			iss: "http://issuer.test",
			login_hint: "sam",
			target_link_uri: `${TOOL}/`,
			client_id: CLIENT_ID,
			lti_deployment_id: DEPLOYMENT_ID,
		});
	});

	it("puts the login inside a frame when asked", async () => {
		const { html } = await start({ person: "sam", course: "cs101", frame: "1" });
		const src = /<iframe title="Portikus" src="([^"]+)"/.exec(html)?.[1] ?? "";
		expect(src).toMatch(/^\/frame\?launch=/);
		const inner = await (await fetch(`${base}${src.replaceAll("&amp;", "&")}`)).text();
		expect(inner).toContain(`action="${TOOL}/lti/login"`);
		expect((await fetch(`${base}/frame?launch=nope`)).status).toBe(404);
	});

	it("refuses a launch page form with unknown values", async () => {
		expect((await start({ person: "zed", course: "cs101" })).status).toBe(400);
		expect((await start({ person: "sam", course: "cs999" })).status).toBe(400);
		expect((await start({ person: "sam", course: "cs101", role: "King" })).status).toBe(
			400,
		);
		expect(
			(await start({ person: "sam", course: "cs101", defect: "odd" })).status,
		).toBe(400);
	});

	it("signs a good launch with the person's seeded role and the course", async () => {
		const { id_token, state } = await launchToken({ person: "ivy", course: "cs240" });
		expect(state).toBe("state-1");
		const { payload, protectedHeader } = await verifyGood(id_token as string);
		expect(protectedHeader).toMatchObject({ alg: "RS256", kid: signer.kid });
		expect(payload).toMatchObject({
			sub: PEOPLE[0]?.sub,
			nonce: "nonce-1",
			name: "Ivy Instructor",
			exp: NOW + 300,
			[`${LTI}message_type`]: "LtiResourceLinkRequest",
			[`${LTI}version`]: "1.3.0",
			[`${LTI}deployment_id`]: DEPLOYMENT_ID,
			[`${LTI}target_link_uri`]: `${TOOL}/`,
			[`${LTI}roles`]: [ROLE_URIS.Instructor],
		});
		expect(payload[`${LTI}context`]).toMatchObject({ title: "CS 240 Data Structures" });
		expect(logs).toEqual(["launch person=ivy defect=none"]);
	});

	it("uses the role chosen on the launch page", async () => {
		const { id_token } = await launchToken({
			person: "sam",
			course: "cs101",
			role: "Instructor",
		});
		expect(decodeJwt(id_token as string)[`${LTI}roles`]).toEqual([
			ROLE_URIS.Instructor,
		]);
	});

	it("gives Ada the institution Administrator role", async () => {
		const { id_token } = await launchToken({ person: "ada", course: "cs101" });
		expect(decodeJwt(id_token as string)[`${LTI}roles`]).toEqual([
			ROLE_URIS.Administrator,
		]);
	});

	it.each([
		["scope", { scope: "profile" }],
		["response_type", { response_type: "code" }],
		["response_mode", { response_mode: "fragment" }],
		["client_id", { client_id: "other" }],
		["redirect_uri", { redirect_uri: "http://evil.test/lti/launch" }],
		["state", { state: "" }],
		["nonce", { nonce: "" }],
		["login_hint", { login_hint: "lee" }],
		["lti_message_hint", { lti_message_hint: "unknown" }],
		["defect", { defect: "odd" }],
	])("refuses an authorization request with a bad %s", async (_name, extra) => {
		const login = await loginFor({ person: "sam", course: "cs101" });
		const { status, html } = await authorize(authorizeParams(login, extra));
		expect(status).toBe(400);
		expect(html).not.toContain('name="id_token"');
		expect(logs).toEqual([]);
	});

	it("accepts the authorization request as a form POST", async () => {
		const login = await loginFor({ person: "sam", course: "cs101" });
		const res = await fetch(`${base}/authorize`, {
			method: "POST",
			body: authorizeParams(login),
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('name="id_token"');
	});

	it("answers 404 for an unknown path", async () => {
		expect((await fetch(`${base}/nope`)).status).toBe(404);
	});

	describe("defects, each wrong in exactly one way", () => {
		async function defective(defect: string, via: "page" | "query") {
			const form = {
				person: "sam",
				course: "cs101",
				...(via === "page" ? { defect } : {}),
			};
			const extra = via === "query" ? { defect } : {};
			return (await launchToken(form, extra)).id_token as string;
		}

		it.each(["page", "query"] as const)("bad_signature, chosen by %s", async (via) => {
			const token = await defective("bad_signature", via);
			expect(decodeProtectedHeader(token)).toMatchObject({
				alg: "RS256",
				kid: signer.kid,
			});
			await expect(verifyGood(token)).rejects.toThrow(/signature/);
			expect(logs).toEqual(["launch person=sam defect=bad_signature"]);
		});

		it("wrong_aud", async () => {
			const token = await defective("wrong_aud", "query");
			const payload = decodeJwt(token);
			expect(payload.aud).not.toBe(CLIENT_ID);
			await expect(verifyGood(token)).rejects.toThrow(/aud/);
		});

		it("expired", async () => {
			const token = await defective("expired", "page");
			const payload = decodeJwt(token);
			expect(payload.exp).toBeLessThan(NOW - 60);
			await expect(verifyGood(token)).rejects.toThrow(/exp/);
		});

		it("alg_none", async () => {
			const token = await defective("alg_none", "page");
			expect(decodeProtectedHeader(token).alg).toBe("none");
			expect(token.endsWith(".")).toBe(true);
			expect(decodeJwt(token).nonce).toBe("nonce-1");
		});

		it.each([
			["unknown_deployment", "deployment_id", "unknown-deployment"],
			["wrong_message_type", "message_type", "LtiDeepLinkingRequest"],
			["wrong_version", "version", "1.1.0"],
			["wrong_target", "target_link_uri", "https://elsewhere.invalid/"],
		])("%s changes only %s", async (defect, claim, value) => {
			const token = await defective(defect, "query");
			const { payload } = await verifyGood(token);
			expect(payload[`${LTI}${claim}`]).toBe(value);
		});

		it("replayed_nonce re-posts the previous token with the new state", async () => {
			const first = await launchToken({ person: "sam", course: "cs101" });
			const second = await launchToken(
				{ person: "sam", course: "cs101", defect: "replayed_nonce" },
				{ state: "state-2", nonce: "nonce-2" },
			);
			expect(second.id_token).toBe(first.id_token);
			expect(second.state).toBe("state-2");
			await verifyGood(second.id_token as string);
			expect(logs[1]).toBe("launch person=sam defect=replayed_nonce");
		});

		it("replayed_nonce replays the last good token, never a defective one", async () => {
			const good = await launchToken({ person: "sam", course: "cs101" });
			await defective("expired", "page");
			const replay = await launchToken(
				{ person: "sam", course: "cs101", defect: "replayed_nonce" },
				{ state: "state-3", nonce: "nonce-3" },
			);
			expect(replay.id_token).toBe(good.id_token);
		});

		it("replayed_nonce after only defective launches is refused", async () => {
			await defective("wrong_aud", "query");
			const login = await loginFor({ person: "sam", course: "cs101" });
			const { status } = await authorize(
				authorizeParams(login, { defect: "replayed_nonce" }),
			);
			expect(status).toBe(400);
		});

		it("replayed_nonce refuses to replay an expired token", async () => {
			await launchToken({ person: "sam", course: "cs101" });
			clock = NOW + 301;
			const login = await loginFor({ person: "sam", course: "cs101" });
			const { status, html } = await authorize(
				authorizeParams(login, { defect: "replayed_nonce" }),
			);
			expect(status).toBe(400);
			expect(html).toContain("Launch once more without a defect, then replay.");
		});

		it("replayed_nonce with no earlier launch is refused", async () => {
			const login = await loginFor({ person: "sam", course: "cs101" });
			const { status } = await authorize(
				authorizeParams(login, { defect: "replayed_nonce" }),
			);
			expect(status).toBe(400);
		});
	});

	it("refuses a start without the launch page's form token", async () => {
		const token = await formToken();
		expect(token.length).toBeGreaterThan(20);
		for (const body of [
			{ person: "sam", course: "cs101" },
			{ person: "sam", course: "cs101", form_token: "wrong" },
			{ person: "sam", course: "cs101", form_token: `${token}x` },
		]) {
			const res = await fetch(`${base}/start`, {
				method: "POST",
				body: new URLSearchParams(body),
			});
			expect(res.status).toBe(403);
		}
		expect(logs.join("\n")).not.toContain(token);
	});

	it("never logs a token", async () => {
		const { id_token } = await launchToken({ person: "lee", course: "cs101" });
		expect(logs.join("\n")).not.toContain(id_token as string);
		expect(logs.join("\n")).not.toContain("Lee");
	});
});

describe("registration", () => {
	it("names the mock's URLs", () => {
		expect(registration("http://10.100.0.1:8765")).toEqual({
			name: "mock-lms",
			issuer: "http://10.100.0.1:8765",
			clientId: "portikus-mock",
			authLoginUrl: "http://10.100.0.1:8765/authorize",
			keysetUrl: "http://10.100.0.1:8765/.well-known/jwks.json",
			deploymentIds: ["mock-deployment-1"],
			mock: true,
		});
	});
});

describe("parseArgs", () => {
	it("defaults to loopback, port 8765, and an issuer from the first bind", () => {
		expect(parseArgs(["--", "--tool-url", "http://localhost:3000/"])).toEqual({
			port: 8765,
			binds: ["127.0.0.1"],
			toolUrl: "http://localhost:3000",
			issuer: "http://127.0.0.1:8765",
		});
	});

	it("takes repeated binds and an explicit issuer", () => {
		const opts = parseArgs([
			"--bind",
			"127.0.0.1",
			"--bind",
			"10.100.0.1",
			"--port",
			"9000",
			"--tool-url",
			"https://portikus.test",
			"--issuer",
			"http://10.100.0.1:9000",
		]);
		expect(opts.binds).toEqual(["127.0.0.1", "10.100.0.1"]);
		expect(opts.issuer).toBe("http://10.100.0.1:9000");
		expect(parseArgs(["--bind", "::1", "--tool-url", "http://x.test"]).issuer).toBe(
			"http://[::1]:8765",
		);
	});

	it.each([
		[[], /tool-url/],
		[["--tool-url"], /needs a value/],
		[["--tool-url", "ftp://x"], /http/],
		[["--tool-url", "not a url"], /URL/],
		[["--tool-url", "http://x", "--port", "0"], /port/],
		[["--tool-url", "http://x", "--color", "red"], /unknown flag/],
	])("refuses %j", (argv, message) => {
		expect(() => parseArgs(argv)).toThrow(message);
	});
});

describe("escapeHtml", () => {
	it("escapes markup characters", () => {
		expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
			"&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
		);
	});
});
