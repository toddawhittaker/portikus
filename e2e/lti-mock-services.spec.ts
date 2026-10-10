/**
 * The mock LMS's roster service and Deep Linking, driven the way later specs
 * will drive them (ADR 0025). The spec signs as the tool, with the tool key
 * the run's API uses.
 */
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { WEB_ORIGIN } from "./helpers";
import {
	changeRoster,
	launchSavedLink,
	MOCK_LMS_ORIGIN,
	resetRosters,
	startDeepLinking,
} from "./lti-helpers";
import { MOCK_LMS_PORT } from "./ports";

const LTI = "https://purl.imsglobal.org/spec/lti/claim/";
const DL = "https://purl.imsglobal.org/spec/lti-dl/claim/";
const NRPS_SCOPE =
	"https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly";
const keyFile = join(tmpdir(), `portikus-e2e-lti-${MOCK_LMS_PORT}`, "lti-tool-key.pem");

test.describe.configure({ mode: "serial" });
test.afterEach(async ({ request }) => {
	await resetRosters(request);
});

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function toolJwt(
	request: import("@playwright/test").APIRequestContext,
	claims: object,
) {
	const jwks = (await (await request.get(`${WEB_ORIGIN}/lti/jwks`)).json()) as {
		keys: { kid: string }[];
	};
	const body = `${b64({ alg: "RS256", typ: "JWT", kid: jwks.keys[0]?.kid })}.${b64({
		exp: Math.floor(Date.now() / 1000) + 300,
		...claims,
	})}`;
	const signature = sign(
		"sha256",
		Buffer.from(body),
		createPrivateKey(readFileSync(keyFile)),
	);
	return `${body}.${signature.toString("base64url")}`;
}

async function accessToken(request: import("@playwright/test").APIRequestContext) {
	const res = await request.post(`${MOCK_LMS_ORIGIN}/token`, {
		form: {
			grant_type: "client_credentials",
			client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
			client_assertion: await toolJwt(request, {
				iss: "portikus-mock",
				sub: "portikus-mock",
				aud: `${MOCK_LMS_ORIGIN}/token`,
				jti: randomUUID(),
			}),
			scope: NRPS_SCOPE,
		},
	});
	expect(res.status()).toBe(200);
	return ((await res.json()) as { access_token: string }).access_token;
}

async function rosterSubjects(request: import("@playwright/test").APIRequestContext) {
	const token = await accessToken(request);
	const res = await request.get(
		`${MOCK_LMS_ORIGIN}/nrps/mock-course-cs101/memberships?limit=100`,
		{ headers: { authorization: `Bearer ${token}` } },
	);
	expect(res.status()).toBe(200);
	const body = (await res.json()) as { members: { user_id: string }[] };
	return body.members.map((m) => m.user_id);
}

test("a roster change shows up in the mock's roster service", async ({ request }) => {
	const dropped = "5d0c1c7e-1f7a-4c1e-9a51-0b8e6f3a2003";
	expect(await rosterSubjects(request)).toContain(dropped);
	await changeRoster(request, { action: "drop", course: "cs101", person: "dro" });
	expect(await rosterSubjects(request)).not.toContain(dropped);
	await changeRoster(request, { action: "add", course: "cs101", person: "dro" });
	expect(await rosterSubjects(request)).toContain(dropped);
});

test("the roster service refuses a caller without a token", async ({ request }) => {
	const res = await request.get(
		`${MOCK_LMS_ORIGIN}/nrps/mock-course-cs101/memberships`,
	);
	expect(res.status()).toBe(401);
});

test("a Deep Linking response is stored and its link launches as a student", async ({
	page,
	request,
}) => {
	// Catch the Deep Linking request the mock posts to the tool, to read its data.
	let idToken = "";
	await page.route("**/lti/launch", async (route) => {
		const form = new URLSearchParams(route.request().postData() ?? "");
		idToken = form.get("id_token") ?? "";
		await route.fulfill({ status: 200, body: "caught" });
	});
	await startDeepLinking(page, { person: "ivy", course: "cs101" });
	await expect.poll(() => idToken).not.toBe("");
	const claims = JSON.parse(
		Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString(),
	);
	const settings = claims[`${DL}deep_linking_settings`] as {
		deep_link_return_url: string;
		data: string;
	};
	expect(claims[`${LTI}message_type`]).toBe("LtiDeepLinkingRequest");

	const returned = await request.post(settings.deep_link_return_url, {
		form: {
			JWT: await toolJwt(request, {
				iss: "portikus-mock",
				aud: MOCK_LMS_ORIGIN,
				[`${LTI}message_type`]: "LtiDeepLinkingResponse",
				[`${LTI}version`]: "1.3.0",
				[`${LTI}deployment_id`]: "mock-deployment-1",
				[`${DL}data`]: settings.data,
				[`${DL}content_items`]: [
					{
						type: "ltiResourceLink",
						title: "Mock project",
						url: `${WEB_ORIGIN}/`,
						custom: { portikus_project: "mock-project", portikus_template: "none" },
					},
				],
			}),
		},
	});
	expect(returned.status()).toBe(200);

	await page.unroute("**/lti/launch");
	await launchSavedLink(page, { title: "Mock project", person: "sam" });
	expect(new URL(page.url()).origin).toBe(WEB_ORIGIN);
});
