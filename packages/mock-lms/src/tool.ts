import { readFileSync } from "node:fs";
import {
	createLocalJWKSet,
	type JSONWebKeySet,
	type JWTPayload,
	jwtVerify,
} from "jose";
import { CLIENT_ID } from "./seed.js";

/** Fetches the tool's public keys; tests replace it. */
export type FetchToolKeys = () => Promise<JSONWebKeySet>;

export function fetchKeysFrom(toolUrl: string): FetchToolKeys {
	return async () => {
		const res = await fetch(`${toolUrl}/lti/jwks`);
		if (!res.ok) throw new Error(`tool keyset answered ${res.status}`);
		return (await res.json()) as JSONWebKeySet;
	};
}

/** The tool's keyset, read once from a file; a key rotation on the tool needs a restart. */
export function keysFromFile(path: string): FetchToolKeys {
	const jwks = JSON.parse(readFileSync(path, "utf8")) as Partial<JSONWebKeySet>;
	if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
		throw new Error(`${path} holds no keyset`);
	}
	const keys = jwks as JSONWebKeySet;
	return async () => keys;
}

/**
 * Verify a JWT the tool signed: RS256, one of the tool's published keys,
 * issued by the tool's client id and addressed to `audience`.
 */
export async function verifyToolJwt(
	fetchKeys: FetchToolKeys,
	token: string,
	audience: string,
	now: number,
	required: string[] = [],
): Promise<JWTPayload> {
	const keys = createLocalJWKSet(await fetchKeys());
	const { payload } = await jwtVerify(token, keys, {
		algorithms: ["RS256"],
		issuer: CLIENT_ID,
		audience,
		currentDate: new Date(now * 1000),
		requiredClaims: required,
	});
	return payload;
}
