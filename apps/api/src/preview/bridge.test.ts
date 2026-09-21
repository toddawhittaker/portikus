import { describe, expect, test } from "vitest";
import { parseBridgeUri } from "./bridge.js";

/** BROWSER-HANDLING.md §14, pattern 2: the reserved same-origin prefix. */
describe("parseBridgeUri accepts", () => {
	test.each([
		["/__portikus/ports/8000/", 8000],
		["/__portikus/ports/8000/api/users", 8000],
		["/__portikus/ports/8000/api?q=1#top", 8000],
		["/__portikus/ports/1/", 1],
		["/__portikus/ports/65535/x", 65535],
	])("%s targets port %i", (uri, port) => {
		expect(parseBridgeUri(uri)).toEqual({ kind: "port", port });
	});
});

describe("parseBridgeUri refuses", () => {
	test.each([
		"/__portikus/ports/08000/x",
		"/__portikus/ports/+8000/x",
		"/__portikus/ports/-1/x",
		"/__portikus/ports/ 8000/x",
		"/__portikus/ports/8000x/y",
		"/__portikus/ports/0/x",
		"/__portikus/ports/65536/x",
		"/__portikus/ports/123456/x",
		"/__portikus/ports/8e3/x",
		"/__portikus/ports/8000",
		"/__portikus/ports//x",
		"/__portikus/ports/",
		"/__portikus/ports/%38%30/x",
	])("%s", (uri) => {
		expect(parseBridgeUri(uri)).toEqual({ kind: "invalid" });
	});
});

describe("parseBridgeUri leaves other requests alone", () => {
	test.each([
		"/",
		"/api/users",
		"/__portikus/portsomething/8000/",
		"//__portikus/ports/8000/",
		"",
	])("%s", (uri) => {
		expect(parseBridgeUri(uri)).toEqual({ kind: "none" });
	});

	test("a missing or non-string header is not a bridge request", () => {
		expect(parseBridgeUri(undefined)).toEqual({ kind: "none" });
		expect(parseBridgeUri(42)).toEqual({ kind: "none" });
	});

	test("a repeated header uses its first value", () => {
		expect(parseBridgeUri(["/__portikus/ports/8000/", "/evil"])).toEqual({
			kind: "port",
			port: 8000,
		});
	});
});
