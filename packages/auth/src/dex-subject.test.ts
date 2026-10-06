import { expect, test } from "vitest";
import {
	dexConnectorId,
	dexLocalSubject,
	dexLocalUserId,
	localDexUserId,
} from "./dex-subject.js";

/** A Dex subject for any connector, with varint lengths as protobuf writes them. */
function subjectFor(userId: string, connId: string): string {
	const field = (tag: number, text: string) => {
		const body = Buffer.from(text, "utf8");
		const length =
			body.length < 128
				? [body.length]
				: [(body.length & 0x7f) | 0x80, body.length >> 7];
		return Buffer.concat([Buffer.from([tag, ...length]), body]);
	};
	return Buffer.concat([field(0x0a, userId), field(0x12, connId)]).toString(
		"base64url",
	);
}

test("reads the connector out of any Dex subject", () => {
	expect(dexConnectorId(dexLocalSubject("x"))).toBe("local");
	expect(dexConnectorId(subjectFor("00000000-oid", "entra"))).toBe("entra");
	// An LDAP DN longer than 127 bytes takes a two-byte length.
	expect(dexConnectorId(subjectFor(`cn=${"a".repeat(200)},dc=example`, "ldap"))).toBe(
		"ldap",
	);
});

test("finds no connector in a subject that is not Dex's", () => {
	expect(dexConnectorId("alice")).toBeNull();
	expect(dexConnectorId("")).toBeNull();
	expect(dexConnectorId(`${subjectFor("bob", "entra")}AA`)).toBeNull();
	expect(dexConnectorId(Buffer.from([0x0a, 3, 0x62]).toString("base64url"))).toBeNull();
});

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
