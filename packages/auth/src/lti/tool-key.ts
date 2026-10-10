import { createHash, createPublicKey } from "node:crypto";

/**
 * The public half of the tool key, with its SHA-256 thumbprint as `kid`
 * (RFC 7638). Empty when there is no key or it is not an RSA key, since
 * the tool signs only with RS256 (ADR 0025).
 */
export function toolJwks(pem: string | null): { keys: Record<string, string>[] } {
	if (!pem) return { keys: [] };
	const jwk = createPublicKey(pem).export({ format: "jwk" });
	const { kty, n, e } = jwk as { kty?: string; n?: string; e?: string };
	if (kty !== "RSA" || !n || !e) return { keys: [] };
	// RFC 7638: the required members, in lexical order, no whitespace.
	const kid = createHash("sha256")
		.update(JSON.stringify({ e, kty, n }))
		.digest("base64url");
	return { keys: [{ kty, n, e, kid, alg: "RS256", use: "sig" }] };
}

/**
 * The `kid` the tool keyset publishes for this private key, so a platform
 * can find the key that verifies what we sign. Throws rather than sign with
 * an empty `kid` no platform could match.
 */
export function toolKeyId(pem: string): string {
	const kid = toolJwks(pem).keys[0]?.kid;
	if (!kid) throw new Error("the tool key has no RSA key id");
	return kid;
}
