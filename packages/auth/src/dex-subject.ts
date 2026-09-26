/**
 * The subject Dex puts in an ID token for a static-password user: the
 * protobuf IDTokenSubject{user_id, conn_id: "local"}, base64url without
 * padding (docs/archive/epics/EPIC-12B.md, "Carrying existing accounts over").
 */
export function dexLocalSubject(userId: string): string {
	const id = Buffer.from(userId, "utf8");
	// A single length byte only works below 128; a UUID is 36.
	if (id.length === 0 || id.length >= 128) {
		throw new Error("userId must be 1 to 127 bytes");
	}
	const conn = Buffer.from("local", "utf8");
	const bytes = Buffer.concat([
		Buffer.from([0x0a, id.length]),
		id,
		Buffer.from([0x12, conn.length]),
		conn,
	]);
	return bytes.toString("base64url");
}

/**
 * The Dex user ID of an account that signs in with a Dex local password:
 * its subject is a local one from this site's own Dex. Null otherwise.
 */
export function localDexUserId(
	row: { oidc_issuer: string; oidc_subject: string },
	issuer: string,
): string | null {
	return row.oidc_issuer === issuer ? dexLocalUserId(row.oidc_subject) : null;
}

/**
 * The Dex user ID inside a local-password subject, or null when the subject
 * is not one (another connector, or not Dex's encoding at all).
 */
export function dexLocalUserId(subject: string): string | null {
	const bytes = Buffer.from(subject, "base64url");
	if (bytes.toString("base64url") !== subject) return null;
	if (bytes.length < 2 || bytes[0] !== 0x0a) return null;
	const idLength = bytes[1] ?? 0;
	const id = bytes.subarray(2, 2 + idLength);
	const rest = bytes.subarray(2 + idLength);
	if (id.length !== idLength || idLength === 0 || idLength >= 128) return null;
	if (!rest.equals(Buffer.from([0x12, 5, ...Buffer.from("local", "utf8")])))
		return null;
	return id.toString("utf8");
}
