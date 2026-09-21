import { describe, expect, test } from "vitest";
import {
	PreviewGrantRequest,
	PreviewPresentation,
	parsePreviewHost,
	previewHost,
} from "./preview.js";

const SUFFIX = "preview.portikus.school.edu";

describe("previewHost", () => {
	test("joins the label, the port, and the suffix", () => {
		expect(previewHost("tw7", 5173, SUFFIX)).toBe(
			"tw7-5173.preview.portikus.school.edu",
		);
	});

	test("round-trips through the parser", () => {
		const host = previewHost("ada-lovelace", 3000, SUFFIX);
		expect(parsePreviewHost(host, SUFFIX)).toEqual({
			label: "ada-lovelace",
			port: 3000,
		});
	});
});

describe("parsePreviewHost accepts", () => {
	test.each([
		["tw7-5173.preview.portikus.school.edu", "tw7", 5173],
		// The label may contain hyphens; the port is what follows the last one.
		["ada-lovelace-3000.preview.portikus.school.edu", "ada-lovelace", 3000],
		["a-1.preview.portikus.school.edu", "a", 1],
		["a-65535.preview.portikus.school.edu", "a", 65535],
		// Host names are case-insensitive on the wire.
		["TW7-5173.PREVIEW.PORTIKUS.SCHOOL.EDU", "tw7", 5173],
		["ws-0a1b2c3d-8080.preview.portikus.school.edu", "ws-0a1b2c3d", 8080],
	])("%s", (host, label, port) => {
		expect(parsePreviewHost(host, SUFFIX)).toEqual({ label, port });
	});
});

describe("parsePreviewHost rejects", () => {
	// A syntactically valid host is never authorization, so anything that is
	// not exactly `<label>-<port>.<suffix>` must be refused outright
	// (BROWSER-HANDLING.md section 8).
	test.each([
		["the empty string", ""],
		["the suffix on its own", SUFFIX],
		["the application host", "portikus.school.edu"],
		["a different suffix", "tw7-5173.preview.evil.example"],
		["a suffix that is only a tail match", "tw7-5173.notpreview.portikus.school.edu"],
		["an extra label in front", "extra.tw7-5173.preview.portikus.school.edu"],
		["a trailing dot", "tw7-5173.preview.portikus.school.edu."],
		["a port on the host", "tw7-5173.preview.portikus.school.edu:8443"],
		["a scheme", "https://tw7-5173.preview.portikus.school.edu"],
		["a path", "tw7-5173.preview.portikus.school.edu/admin"],
		["userinfo", "user@tw7-5173.preview.portikus.school.edu"],
		["no port at all", "tw7.preview.portikus.school.edu"],
		["no label at all", "-5173.preview.portikus.school.edu"],
		["an empty port", "tw7-.preview.portikus.school.edu"],
		["a leading zero", "tw7-05173.preview.portikus.school.edu"],
		["a port that is only zeros", "tw7-000.preview.portikus.school.edu"],
		["port zero", "tw7-0.preview.portikus.school.edu"],
		["a plus sign", "tw7-+5173.preview.portikus.school.edu"],
		["a minus sign", "tw7--5173.preview.portikus.school.edu"],
		["a hex port", "tw7-0x1f.preview.portikus.school.edu"],
		["an octal port", "tw7-0o17.preview.portikus.school.edu"],
		["exponent notation", "tw7-1e3.preview.portikus.school.edu"],
		["a decimal point", "tw7-5173.5.preview.portikus.school.edu"],
		["whitespace in the port", "tw7- 5173.preview.portikus.school.edu"],
		["a port above the range", "tw7-65536.preview.portikus.school.edu"],
		["an overflowing port", "tw7-999999999999.preview.portikus.school.edu"],
		["a label ending in a hyphen", "tw7---5173.preview.portikus.school.edu"],
		["a label starting with a hyphen", "-tw7-5173.preview.portikus.school.edu"],
		["an underscore in the label", "tw_7-5173.preview.portikus.school.edu"],
		["Unicode digits", "tw7-٥١٧٣.preview.portikus.school.edu"],
		["a Cyrillic look-alike label", "тw7-5173.preview.portikus.school.edu"],
		["a full-width digit", "tw7-5１73.preview.portikus.school.edu"],
		["a NUL byte", "tw7-5173\u0000.preview.portikus.school.edu"],
		["a newline", "tw7-5173\n.preview.portikus.school.edu"],
		[
			"a punycode-looking label with a dot",
			"xn--tw7.1-5173.preview.portikus.school.edu",
		],
		["a label longer than a DNS label", `${"a".repeat(60)}-5173.${SUFFIX}`],
	])("%s", (_name, host) => {
		expect(parsePreviewHost(host, SUFFIX)).toBeNull();
	});

	test("a host longer than a DNS name", () => {
		const host = `${"a".repeat(200)}-5173.${SUFFIX}`;
		expect(parsePreviewHost(host, SUFFIX)).toBeNull();
	});

	test("an empty suffix", () => {
		expect(parsePreviewHost("tw7-5173.preview.localhost", "")).toBeNull();
	});
});

describe("preview contracts", () => {
	test("presentation is one of the two modes", () => {
		expect(PreviewPresentation.safeParse("embedded").success).toBe(true);
		expect(PreviewPresentation.safeParse("top-level").success).toBe(true);
		expect(PreviewPresentation.safeParse("popup").success).toBe(false);
	});

	test("the grant request rejects ports outside 1..65535", () => {
		expect(
			PreviewGrantRequest.safeParse({ port: 5173, presentation: "embedded" }).success,
		).toBe(true);
		for (const port of [0, -1, 65536, 1.5]) {
			expect(
				PreviewGrantRequest.safeParse({ port, presentation: "embedded" }).success,
			).toBe(false);
		}
	});
});
