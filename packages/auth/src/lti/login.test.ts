import { describe, expect, test } from "vitest";
import { isOnOrigin, type LtiLoginParams, startLtiLogin } from "./login.js";
import type { LtiPlatform } from "./platforms.js";

const PUBLIC_URL = "https://portikus.example.edu";

const canvas: LtiPlatform = {
	name: "Canvas",
	issuer: "https://canvas.instructure.com",
	clientId: "c1",
	authLoginUrl: "https://sso.canvaslms.com/api/lti/authorize_redirect?x=1",
	keysetUrl: "https://sso.canvaslms.com/api/lti/security/jwks",
	deploymentIds: ["d1"],
	mock: false,
};
const canvas2 = { ...canvas, name: "Canvas 2", clientId: "c2" };

const params: LtiLoginParams = {
	iss: canvas.issuer,
	client_id: "c1",
	login_hint: "hint-1",
	target_link_uri: `${PUBLIC_URL}/`,
	lti_message_hint: "msg-1",
	lti_deployment_id: "d1",
};

describe("startLtiLogin", () => {
	test("builds the authorization request the brief lists", () => {
		const result = startLtiLogin([canvas, canvas2], PUBLIC_URL, params);
		if (!result.ok) throw new Error(result.reason);
		expect(result.platform).toBe(canvas);
		const url = new URL(result.redirectUrl);
		expect(url.origin + url.pathname).toBe(
			"https://sso.canvaslms.com/api/lti/authorize_redirect",
		);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			x: "1",
			scope: "openid",
			response_type: "id_token",
			response_mode: "form_post",
			prompt: "none",
			client_id: "c1",
			redirect_uri: `${PUBLIC_URL}/lti/launch`,
			login_hint: "hint-1",
			lti_message_hint: "msg-1",
			state: result.state,
			nonce: result.nonce,
		});
	});

	test("state and nonce are 32 random bytes, fresh each time", () => {
		const a = startLtiLogin([canvas], PUBLIC_URL, params);
		const b = startLtiLogin([canvas], PUBLIC_URL, params);
		if (!a.ok || !b.ok) throw new Error("refused");
		expect(Buffer.from(a.state, "base64url")).toHaveLength(32);
		expect(Buffer.from(a.nonce, "base64url")).toHaveLength(32);
		expect(new Set([a.state, a.nonce, b.state, b.nonce]).size).toBe(4);
	});

	test("omits lti_message_hint when not given", () => {
		const result = startLtiLogin([canvas], PUBLIC_URL, {
			...params,
			lti_message_hint: undefined,
		});
		if (!result.ok) throw new Error(result.reason);
		expect(new URL(result.redirectUrl).searchParams.has("lti_message_hint")).toBe(
			false,
		);
	});

	test("uses the only registration when client_id is absent", () => {
		const result = startLtiLogin([canvas], PUBLIC_URL, {
			...params,
			client_id: undefined,
		});
		expect(result.ok && result.platform).toBe(canvas);
	});

	test.each<[string, LtiLoginParams, string]>([
		["no issuer", { ...params, iss: undefined }, "unknown_issuer"],
		[
			"an unknown issuer",
			{ ...params, iss: "https://evil.example.com" },
			"unknown_issuer",
		],
		["an unknown client id", { ...params, client_id: "c9" }, "unknown_issuer"],
		[
			"no client id with several registrations",
			{ ...params, client_id: undefined },
			"unknown_issuer",
		],
		["no login hint", { ...params, login_hint: "" }, "missing_login_hint"],
		["no target", { ...params, target_link_uri: undefined }, "wrong_target"],
		[
			"a target off our origin",
			{ ...params, target_link_uri: "https://evil.example.com/" },
			"wrong_target",
		],
		[
			"a target on another port",
			{ ...params, target_link_uri: "https://portikus.example.edu:8443/" },
			"wrong_target",
		],
	])("refuses %s", (_label, input, reason) => {
		expect(startLtiLogin([canvas, canvas2], PUBLIC_URL, input)).toEqual({
			ok: false,
			reason,
		});
	});
});

describe("isOnOrigin", () => {
	test.each([
		[`${PUBLIC_URL}/workspace?x=1`, true],
		["http://portikus.example.edu/", false],
		["//evil.example.com/", false],
		["/relative", false],
		["", false],
	])("%s is %s", (uri, expected) => {
		expect(isOnOrigin(uri, PUBLIC_URL)).toBe(expected);
	});
});
