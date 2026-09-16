import { describe, expect, test } from "vitest";
import {
	checkCsrf,
	checkWsOrigin,
	loginCookieName,
	loginCookieOptions,
	sessionCookieName,
	sessionCookieOptions,
} from "./plugin.js";
import type { AuthOptions } from "./types.js";

const ORIGIN = "https://portikus.example.edu";

const opts: AuthOptions = {
	publicUrl: ORIGIN,
	issuerUrl: "https://idp.example.edu",
	clientId: "portikus",
	clientSecret: "secret",
	scopes: "openid profile email",
	groupsClaim: "groups",
	studentGroup: "portikus-students",
	adminGroup: "portikus-administrators",
	cookieSecret: "cookie-secret",
	sessionTtlSeconds: 43200,
};

describe("checkCsrf", () => {
	test.each([
		["same-origin fetch metadata", { "sec-fetch-site": "same-origin" }, true],
		["a top-level navigation", { "sec-fetch-site": "none" }, true],
		["same-site but cross-origin", { "sec-fetch-site": "same-site" }, false],
		["cross-site with no origin", { "sec-fetch-site": "cross-site" }, false],
		[
			"cross-site claiming our origin",
			{ "sec-fetch-site": "cross-site", origin: ORIGIN },
			false,
		],
		["a matching origin alone", { origin: ORIGIN }, true],
		["another site's origin", { origin: "https://evil.example.com" }, false],
		["no headers at all", {}, false],
	])("%s", (_name, headers, expected) => {
		expect(checkCsrf(headers, ORIGIN)).toBe(expected);
	});
});

describe("checkWsOrigin", () => {
	test.each([
		["a matching origin", { origin: ORIGIN }, true],
		["a different origin", { origin: "https://evil.example.com" }, false],
		["a missing origin", {}, false],
		["fetch metadata without an origin", { "sec-fetch-site": "same-origin" }, false],
	])("%s", (_name, headers, expected) => {
		expect(checkWsOrigin(headers, ORIGIN)).toBe(expected);
	});
});

describe("cookie options", () => {
	test("the session cookie is HttpOnly, Lax, and Secure on https", () => {
		expect(sessionCookieOptions(opts)).toEqual({
			httpOnly: true,
			sameSite: "lax",
			path: "/",
			secure: true,
			maxAge: 43200,
		});
	});

	test("the cookie is not Secure when the site is plain http", () => {
		expect(
			sessionCookieOptions({ ...opts, publicUrl: "http://127.0.0.1:5173" }).secure,
		).toBe(false);
	});

	test("https gets the __Host- prefix and http does not", () => {
		expect(sessionCookieName(opts)).toBe("__Host-portikus_session");
		expect(loginCookieName(opts)).toBe("__Host-portikus_login");
		const plain = { ...opts, publicUrl: "http://127.0.0.1:5173" };
		expect(sessionCookieName(plain)).toBe("portikus_session");
		expect(loginCookieName(plain)).toBe("portikus_login");
	});

	test("the prefixed cookie is Secure, Path=/ and has no Domain", () => {
		const options = sessionCookieOptions(opts);
		expect(options.secure).toBe(true);
		expect(options.path).toBe("/");
		expect(options.domain).toBeUndefined();
	});

	test("the login cookie is signed and short lived", () => {
		const login = loginCookieOptions(opts);
		expect(login.signed).toBe(true);
		expect(login.maxAge).toBe(600);
		expect(login.httpOnly).toBe(true);
	});
});
