/**
 * The subject Dex puts in an ID token for a static-password user: the
 * protobuf IDTokenSubject{user_id, conn_id: "local"}, base64url without
 * padding (docs/EPIC-12B.md, "Carrying existing accounts over").
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
