import { describe, expect, test } from "vitest";
import {
	base32Decode,
	base32Encode,
	matchTotp,
	otpauthUri,
	totpCode,
	totpStep,
} from "./totp.js";

// RFC 6238 appendix B, SHA-1 rows; the 6-digit code is the last six of its 8 digits.
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");
const RFC_VECTORS: [number, string][] = [
	[59, "287082"],
	[1111111109, "081804"],
	[1111111111, "050471"],
	[1234567890, "005924"],
	[2000000000, "279037"],
	[20000000000, "353130"],
];

describe("TOTP (RFC 6238, SPEC.md section 24.13)", () => {
	test.each(RFC_VECTORS)("time %i gives %s", (seconds, code) => {
		expect(totpCode(RFC_SECRET, totpStep(seconds * 1000))).toBe(code);
	});

	test("base32 round-trips and matches the RFC 4648 example", () => {
		expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
		expect(base32Decode("MZXW6YTBOI").toString()).toBe("foobar");
		expect(base32Decode(base32Encode(RFC_SECRET))).toEqual(RFC_SECRET);
	});

	test("a code one step early or late still matches, two steps does not", () => {
		const now = 1234567890 * 1000;
		const step = totpStep(now);
		expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now, null)).toBe(
			step - 1,
		);
		expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), now, null)).toBe(
			step + 1,
		);
		expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), now, null)).toBeNull();
	});

	test("a code at or before the last accepted step never matches again", () => {
		const now = 1234567890 * 1000;
		const step = totpStep(now);
		const code = totpCode(RFC_SECRET, step);
		expect(matchTotp(RFC_SECRET, code, now, step)).toBeNull();
		expect(matchTotp(RFC_SECRET, code, now, step - 1)).toBe(step);
	});

	test("anything but six digits is refused", () => {
		expect(matchTotp(RFC_SECRET, "28708", 59_000, null)).toBeNull();
		expect(matchTotp(RFC_SECRET, "abcdef", 59_000, null)).toBeNull();
	});

	test("the otpauth URI carries the secret and parameters", () => {
		const uri = new URL(otpauthUri(RFC_SECRET, "Portikus", "ada@example.edu"));
		expect(uri.protocol).toBe("otpauth:");
		expect(uri.searchParams.get("secret")).toBe(base32Encode(RFC_SECRET));
		expect(uri.searchParams.get("digits")).toBe("6");
		expect(uri.searchParams.get("period")).toBe("30");
		expect(uri.pathname).toContain("Portikus:ada%40example.edu");
	});
});
