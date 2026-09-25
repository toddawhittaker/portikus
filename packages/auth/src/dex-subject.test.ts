import { expect, test } from "vitest";
import { dexLocalSubject, dexLocalUserId, localDexUserId } from "./dex-subject.js";

test("matches Dex's documented example for a static password", () => {
	expect(dexLocalSubject("08a8684b-db88-4b73-90a9-3cd1661f5466")).toBe(
		"CiQwOGE4Njg0Yi1kYjg4LTRiNzMtOTBhOS0zY2QxNjYxZjU0NjYSBWxvY2Fs",
	);
});

test("refuses a user id the one-byte length cannot encode", () => {
	expect(() => dexLocalSubject("x".repeat(128))).toThrow();
	expect(() => dexLocalSubject("")).toThrow();
});

test("reads the user id back out of a local-password subject", () => {
	const id = "08a8684b-db88-4b73-90a9-3cd1661f5466";
	expect(dexLocalUserId(dexLocalSubject(id))).toBe(id);
});

test("finds no user id in a subject from another connector or provider", () => {
	const ldap = Buffer.concat([
		Buffer.from([0x0a, 3]),
		Buffer.from("bob"),
		Buffer.from([0x12, 4]),
		Buffer.from("ldap"),
	]).toString("base64url");
	expect(dexLocalUserId(ldap)).toBeNull();
	expect(dexLocalUserId("alice")).toBeNull();
	expect(dexLocalUserId("")).toBeNull();
	expect(dexLocalUserId(`${dexLocalSubject("x")}AA`)).toBeNull();
});

test("a local Dex user only when the issuer is this site's Dex", () => {
	const id = "08a8684b-db88-4b73-90a9-3cd1661f5466";
	const row = { oidc_issuer: "https://dex.example", oidc_subject: dexLocalSubject(id) };
	expect(localDexUserId(row, "https://dex.example")).toBe(id);
	expect(localDexUserId(row, "https://other.example")).toBeNull();
	expect(
		localDexUserId({ ...row, oidc_subject: "google-123" }, "https://dex.example"),
	).toBeNull();
});
