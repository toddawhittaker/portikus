import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { createOidcClient } from "@portikus/auth";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { toAuthOptions } from "../auth-options.js";
import { buildServer } from "../server.js";
import {
	deepLinkingClaims,
	type FakeLms,
	LTI_CLAIM,
	LTI_CLIENT_ID,
	LTI_DL_CLAIM,
	LTI_ISSUER,
	LTI_ROLE,
	ltiLaunch,
	resourceLinkClaims,
	sessionCookieOf,
	startFakeLms,
} from "../testing/lti-launch.js";
import { PUBLIC_URL, testConfig } from "../testing/test-support.js";

/**
 * LTI Deep Linking: the picker, its signed response, and the student's
 * starter launch (ADR 0058, SPEC.md §7.2, §24).
 */

const skip = !hasTestDb();
const RETURN_URL = `${LTI_ISSUER}/deeplink/return`;
const TEMPLATE = { name: "Starter", url: "https://example.com/starter.git" };
const toolKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
	.privateKey.export({ type: "pkcs8", format: "pem" })
	.toString();

let testDb: TestDb;
let lms: FakeLms;
let app: FastifyInstance;
let lines: Record<string, unknown>[];

beforeAll(async () => {
	lms = await startFakeLms();
	if (skip) return;
	testDb = await createTestDb();
});

afterAll(async () => {
	await lms.close();
	if (skip) return;
	await testDb.close();
});

function build(keyPem: string | null): FastifyInstance {
	const config = testConfig("http://127.0.0.1:1/unused", {
		PROJECT_TEMPLATES: `${TEMPLATE.name}=${TEMPLATE.url}`,
		projectTemplates: [TEMPLATE],
	});
	const collected = collectingLogger("debug");
	lines = collected.lines;
	return buildServer({
		db: testDb.db,
		config,
		logger: collected.logger,
		oidc: createOidcClient(toAuthOptions(config)),
		lti: { platforms: [lms.platform], toolKeyPem: keyPem },
	});
}

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	app = build(toolKeyPem);
	await app.ready();
	return () => app.close();
});

function hidden(html: string, name: string): string {
	const value = new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
	if (value === undefined) throw new Error(`no hidden field ${name}`);
	return value;
}

/** A Deep Linking request through login and launch; returns the picker's handle. */
async function openPicker(
	edit: (claims: Record<string, unknown>) => void = () => {},
): Promise<{ res: LightMyRequestResponse; handle: string }> {
	const res = await ltiLaunch(app, lms, (nonce) => {
		const claims = deepLinkingClaims({ sub: "ivy-1" }, nonce, RETURN_URL);
		edit(claims);
		return claims;
	});
	expect(res.statusCode).toBe(200);
	return { res, handle: hidden(res.body, "handle") };
}

function submit(fields: Record<string, string>): Promise<LightMyRequestResponse> {
	return app.inject({
		method: "POST",
		url: "/lti/deep-link",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"sec-fetch-site": "same-origin",
		},
		payload: new URLSearchParams(fields).toString(),
	});
}

/** The response JWT's claims, after checking it is signed by the tool key. */
function verifiedClaims(jwt: string): Record<string, unknown> {
	const [header, payload, signature] = jwt.split(".") as [string, string, string];
	const ok = verify(
		"sha256",
		Buffer.from(`${header}.${payload}`),
		createPublicKey(toolKeyPem),
		Buffer.from(signature, "base64url"),
	);
	expect(ok).toBe(true);
	return JSON.parse(Buffer.from(payload, "base64url").toString());
}

async function rows(
	table: "users" | "sessions" | "lti_contexts" | "lti_deep_link_requests",
) {
	return testDb.db.selectFrom(table).selectAll().execute();
}

describe.skipIf(skip)("a Deep Linking request", () => {
	test("creates no session, no account and no membership", async () => {
		const res = await ltiLaunch(app, lms, (nonce) =>
			deepLinkingClaims({ sub: "ivy-1" }, nonce),
		);
		expect(sessionCookieOf(res)).toBeUndefined();
		expect(res.statusCode).not.toBe(303);
		expect(await rows("users")).toEqual([]);
		expect(await rows("sessions")).toEqual([]);
		expect(await rows("lti_contexts")).toEqual([]);
	});

	test("answers a script-free picker and keeps only the handle's hash", async () => {
		const { res, handle } = await openPicker();
		expect(res.headers["content-type"]).toContain("text/html");
		expect(res.headers["cache-control"]).toBe("no-store");
		expect(res.body).not.toMatch(/<script/i);
		expect(res.body).toContain('action="/lti/deep-link"');
		expect(res.body).toContain('value="template:Starter"');
		expect(res.body).toContain('value="repository"');
		const stored = await rows("lti_deep_link_requests");
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({
			platform_issuer: LTI_ISSUER,
			client_id: LTI_CLIENT_ID,
			deployment_id: "dep-1",
			return_url: RETURN_URL,
			data: "opaque-data",
		});
		expect(stored[0]?.state_hash).not.toContain(handle);
		const minutes = ((stored[0]?.expires_at.getTime() ?? 0) - Date.now()) / 60_000;
		expect(minutes).toBeGreaterThan(9);
		expect(minutes).toBeLessThanOrEqual(10);
	});

	test("a learner is refused as not_instructor, with no picker and no session", async () => {
		const res = await ltiLaunch(app, lms, (nonce) =>
			deepLinkingClaims({ sub: "sam-1", roles: [`${LTI_ROLE}Learner`] }, nonce),
		);
		expect(res.statusCode).toBe(401);
		expect(sessionCookieOf(res)).toBeUndefined();
		expect(await rows("lti_deep_link_requests")).toEqual([]);
		expect(await rows("users")).toEqual([]);
		const audit = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "auth.login")
			.executeTakeFirstOrThrow();
		expect(audit.metadata).toMatchObject({ reason: "not_instructor" });
		expect(audit.result).toBe("failed");
	});

	test("a return URL that is not http or https is refused before any picker", async () => {
		const res = await ltiLaunch(app, lms, (nonce) =>
			deepLinkingClaims({ sub: "ivy-1" }, nonce, "javascript:alert(1)"),
		);
		expect(res.statusCode).toBe(401);
		expect(await rows("lti_deep_link_requests")).toEqual([]);
	});
});

describe.skipIf(skip)("submitting the picker", () => {
	test("a template signs a response for the stored request and offers a button back", async () => {
		const { handle } = await openPicker();
		const res = await submit({
			handle,
			choice: "template:Starter",
			project: "Lab One",
		});
		expect(res.statusCode).toBe(200);
		expect(sessionCookieOf(res)).toBeUndefined();
		expect(res.body).not.toMatch(/<script/i);
		expect(res.body).toContain(`<form method="post" action="${RETURN_URL}">`);
		expect(res.body).toContain("Return to your course");
		const csp = String(res.headers["content-security-policy"]);
		expect(csp).toContain(`form-action ${new URL(RETURN_URL).origin}`);
		expect(csp).toContain("frame-ancestors 'none'");

		const claims = verifiedClaims(hidden(res.body, "JWT"));
		expect(claims).toMatchObject({
			iss: LTI_CLIENT_ID,
			aud: LTI_ISSUER,
			[`${LTI_CLAIM}message_type`]: "LtiDeepLinkingResponse",
			[`${LTI_CLAIM}deployment_id`]: "dep-1",
			[`${LTI_DL_CLAIM}data`]: "opaque-data",
			[`${LTI_DL_CLAIM}content_items`]: [
				{
					type: "ltiResourceLink",
					title: "Lab One",
					url: `${PUBLIC_URL}/`,
					custom: { portikus_project: "Lab One", portikus_template: "Starter" },
				},
			],
		});

		const audit = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "lti.deep_link")
			.executeTakeFirstOrThrow();
		expect(audit.result).toBe("ok");
		expect(audit.metadata).toMatchObject({
			platform: "Test LMS",
			source: "template",
			template: "Starter",
		});
		expect(await rows("users")).toEqual([]);

		const logged = JSON.stringify(lines);
		expect(logged).not.toContain(handle);
		expect(logged).not.toContain(hidden(res.body, "JWT"));
	});

	test("a public https repository is carried as portikus_repository, named after its folder", async () => {
		const { handle } = await openPicker();
		const res = await submit({
			handle,
			choice: "repository",
			repository: "https://github.com/owner/ipeds-oracle.git",
			project: "",
		});
		expect(res.statusCode).toBe(200);
		const claims = verifiedClaims(hidden(res.body, "JWT"));
		expect(claims[`${LTI_DL_CLAIM}content_items`]).toEqual([
			{
				type: "ltiResourceLink",
				title: "Ipeds Oracle",
				url: `${PUBLIC_URL}/`,
				custom: {
					portikus_project: "Ipeds Oracle",
					portikus_repository: "https://github.com/owner/ipeds-oracle.git",
				},
			},
		]);
	});

	test.each([
		["an ssh URL", "ssh://git@github.com/owner/repo.git"],
		["an scp-like URL", "git@github.com:owner/repo.git"],
		["a plain http URL", "http://example.com/repo.git"],
		["credentials", "https://token@example.com/repo.git"],
		["nothing", ""],
	])(
		"a repository given as %s is refused and the picker is shown again",
		async (_label, url) => {
			const { handle } = await openPicker();
			const res = await submit({
				handle,
				choice: "repository",
				repository: url,
				project: "Lab",
			});
			expect(res.statusCode).toBe(400);
			expect(res.body).toContain('id="picker-error"');
			expect(hidden(res.body, "handle")).toBe(handle);
			// The request is still there, so a corrected choice goes through.
			const again = await submit({
				handle,
				choice: "template:Starter",
				project: "Lab",
			});
			expect(again.statusCode).toBe(200);
		},
	);

	test("an unknown template or a name with no letter or digit is refused", async () => {
		const { handle } = await openPicker();
		expect(
			(await submit({ handle, choice: "template:Nope", project: "" })).statusCode,
		).toBe(400);
		expect(
			(await submit({ handle, choice: "template:Starter", project: "!!!" })).statusCode,
		).toBe(400);
		expect((await submit({ handle, choice: "", project: "Lab" })).statusCode).toBe(400);
	});

	test("a replayed handle is refused: the request is single use", async () => {
		const { handle } = await openPicker();
		expect((await submit({ handle, choice: "template:Starter" })).statusCode).toBe(200);
		const replay = await submit({ handle, choice: "template:Starter" });
		expect(replay.statusCode).toBe(400);
		expect(replay.body).toContain("This page has expired");
		expect(replay.body).not.toContain("JWT");
	});

	test("an expired or unknown handle is refused", async () => {
		const { handle } = await openPicker();
		await testDb.db
			.updateTable("lti_deep_link_requests")
			.set({ expires_at: new Date(Date.now() - 1000).toISOString() })
			.execute();
		expect((await submit({ handle, choice: "template:Starter" })).statusCode).toBe(400);
		expect(
			(await submit({ handle: "made-up", choice: "template:Starter" })).statusCode,
		).toBe(400);
		expect((await submit({ choice: "template:Starter" })).statusCode).toBe(400);
	});

	test("the return URL is only ever the signed one, never a form field", async () => {
		const { handle } = await openPicker();
		const res = await submit({
			handle,
			choice: "template:Starter",
			return_url: "https://evil.example/steal",
			deep_link_return_url: "https://evil.example/steal",
		});
		expect(res.statusCode).toBe(200);
		expect(res.body).not.toContain("evil.example");
		expect(String(res.headers["content-security-policy"])).not.toContain(
			"evil.example",
		);
	});

	test("a cross-site submit is refused by the CSRF check", async () => {
		const { handle } = await openPicker();
		const res = await app.inject({
			method: "POST",
			url: "/lti/deep-link",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"sec-fetch-site": "cross-site",
			},
			payload: new URLSearchParams({ handle, choice: "template:Starter" }).toString(),
		});
		expect(res.statusCode).toBe(403);
	});

	test("with no tool key the submit answers 503 and keeps the request", async () => {
		const { handle } = await openPicker();
		await app.close();
		app = build(null);
		await app.ready();
		const res = await submit({ handle, choice: "template:Starter" });
		expect(res.statusCode).toBe(503);
		expect(await rows("lti_deep_link_requests")).toHaveLength(1);
	});
});

describe.skipIf(skip)("a student's starter launch", () => {
	const starterCustom = {
		portikus_project: "Lab One",
		portikus_template: "Starter",
	};

	test("lands on /?starter=<id>, bound to the user for 30 minutes", async () => {
		const res = await ltiLaunch(app, lms, (nonce) =>
			resourceLinkClaims({ sub: "sam-1", custom: starterCustom }, nonce),
		);
		expect(res.statusCode).toBe(303);
		const id = /^\/\?starter=([0-9a-f-]{36})$/.exec(String(res.headers.location))?.[1];
		expect(id).toBeDefined();
		const user = await testDb.db
			.selectFrom("users")
			.selectAll()
			.executeTakeFirstOrThrow();
		const starter = await testDb.db
			.selectFrom("lti_starter_launches")
			.selectAll()
			.executeTakeFirstOrThrow();
		expect(starter).toMatchObject({
			id,
			user_id: user.id,
			project_name: "Lab One",
			template: "Starter",
			repository_url: null,
		});
		const minutes = (starter.expires_at.getTime() - Date.now()) / 60_000;
		expect(minutes).toBeGreaterThan(29);
		expect(minutes).toBeLessThanOrEqual(30);
	});

	test("a repository link is stored with its URL", async () => {
		await ltiLaunch(app, lms, (nonce) =>
			resourceLinkClaims(
				{
					sub: "sam-1",
					custom: {
						portikus_project: "Oracle",
						portikus_repository: "https://github.com/owner/oracle.git",
					},
				},
				nonce,
			),
		);
		const starter = await testDb.db
			.selectFrom("lti_starter_launches")
			.selectAll()
			.executeTakeFirstOrThrow();
		expect(starter).toMatchObject({
			template: null,
			repository_url: "https://github.com/owner/oracle.git",
		});
	});

	test.each<[string, Record<string, string>]>([
		[
			"a template no longer configured",
			{ portikus_project: "Lab", portikus_template: "Gone" },
		],
		[
			"both a template and a repository",
			{
				portikus_project: "Lab",
				portikus_template: "Starter",
				portikus_repository: "https://github.com/o/r.git",
			},
		],
		[
			"an ssh repository",
			{ portikus_project: "Lab", portikus_repository: "git@github.com:o/r.git" },
		],
		["a blank project name", { portikus_project: " ", portikus_template: "Starter" }],
	])("%s signs in to the plain target with no starter", async (_label, custom) => {
		const res = await ltiLaunch(app, lms, (nonce) =>
			resourceLinkClaims({ sub: "sam-1", custom }, nonce),
		);
		expect(res.statusCode).toBe(303);
		expect(res.headers.location).toBe("/");
		expect(
			await testDb.db.selectFrom("lti_starter_launches").selectAll().execute(),
		).toEqual([]);
	});

	test("a launch records the course's client id and roster URL", async () => {
		const membershipsUrl = `${LTI_ISSUER}/nrps/ctx-1/memberships`;
		await ltiLaunch(app, lms, (nonce) => ({
			...resourceLinkClaims({ sub: "sam-1" }, nonce),
			"https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice": {
				context_memberships_url: membershipsUrl,
				service_versions: ["2.0"],
			},
		}));
		const course = await testDb.db
			.selectFrom("lti_contexts")
			.selectAll()
			.executeTakeFirstOrThrow();
		expect(course).toMatchObject({
			platform_client_id: LTI_CLIENT_ID,
			nrps_url: membershipsUrl,
		});
	});
});
