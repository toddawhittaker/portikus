/**
 * The subject Dex puts in an ID token: the protobuf
 * IDTokenSubject{user_id, conn_id}, base64url without padding (ADR 0023).
 */
export function dexSubject(userId: string, connectorId: string): string {
	const id = Buffer.from(userId, "utf8");
	const conn = Buffer.from(connectorId, "utf8");
	// A single length byte only works below 128; a UUID is 36.
	if (id.length === 0 || id.length >= 128) {
		throw new Error("userId must be 1 to 127 bytes");
	}
	if (conn.length === 0 || conn.length >= 128) {
		throw new Error("connectorId must be 1 to 127 bytes");
	}
	const bytes = Buffer.concat([
		Buffer.from([0x0a, id.length]),
		id,
		Buffer.from([0x12, conn.length]),
		conn,
	]);
	return bytes.toString("base64url");
}

/** The subject of a Dex static-password user. */
export function dexLocalSubject(userId: string): string {
	return dexSubject(userId, "local");
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

/** A protobuf varint at `at`, or null when it runs off the end. */
function readVarint(bytes: Buffer, at: number): { value: number; next: number } | null {
	let value = 0;
	for (let i = 0; i < 4; i++) {
		const byte = bytes[at + i];
		if (byte === undefined) return null;
		value |= (byte & 0x7f) << (7 * i);
		if ((byte & 0x80) === 0) return { value, next: at + i + 1 };
	}
	return null;
}

/**
 * The Dex connector ID inside any Dex subject ("local", "entra", "google",
 * "ldap", "oidc"), or null when the subject is not Dex's encoding. Upstream
 * user IDs, such as an LDAP DN, can pass 127 bytes, so lengths are varints.
 */
export function dexConnectorId(subject: string): string | null {
	const bytes = Buffer.from(subject, "base64url");
	if (bytes.length === 0 || bytes.toString("base64url") !== subject) return null;
	if (bytes[0] !== 0x0a) return null;
	const idLength = readVarint(bytes, 1);
	if (!idLength || idLength.value === 0) return null;
	const connAt = idLength.next + idLength.value;
	if (bytes[connAt] !== 0x12) return null;
	const connLength = readVarint(bytes, connAt + 1);
	if (!connLength || connLength.value === 0) return null;
	if (connLength.next + connLength.value !== bytes.length) return null;
	return bytes.subarray(connLength.next).toString("utf8");
}
