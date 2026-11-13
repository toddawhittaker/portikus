import { expect, test } from "vitest";
import { decodeHexAddress } from "./proc-net.js";

test("shortens the zero run in the middle of an IPv6 address", () => {
	expect(decodeHexAddress("B80D0120000000000000000001000000")).toBe("2001:db8::1");
});

test("shortens only the first of two equally long zero runs", () => {
	expect(decodeHexAddress("00000100010000000000000001000100")).toBe("1::1:0:0:1:1");
});

test("leaves single zero groups unshortened", () => {
	expect(decodeHexAddress("00000100000001000000010000000100")).toBe("1:0:1:0:1:0:1:0");
});
