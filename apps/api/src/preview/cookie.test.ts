import { describe, expect, test } from "vitest";
import { previewCookieOptions } from "./cookie.js";

describe("previewCookieOptions (BROWSER-HANDLING.md §7.2)", () => {
	test("an embedded preview framed from another site is partitioned", () => {
		expect(
			previewCookieOptions({ "sec-fetch-site": "cross-site" }, true, true),
		).toEqual({
			httpOnly: true,
			secure: true,
			sameSite: "none",
			partitioned: true,
			path: "/",
		});
	});

	test("a partitioned cookie is always Secure, which SameSite=None requires", () => {
		expect(
			previewCookieOptions({ "sec-fetch-site": "cross-site" }, true, false).secure,
		).toBe(true);
	});

	test.each([
		["same-site", true],
		["same-origin", true],
		["none", true],
		[undefined, true],
		[["cross-site"], true],
		["cross-site", false],
		[undefined, false],
	])("Sec-Fetch-Site %s, embedded %s stays strict", (site, embedded) => {
		const headers = site === undefined ? {} : { "sec-fetch-site": site };
		expect(previewCookieOptions(headers, embedded, true)).toEqual({
			httpOnly: true,
			secure: true,
			sameSite: "strict",
			path: "/",
		});
		expect(previewCookieOptions(headers, embedded, false).secure).toBe(false);
	});
});
