import { createPrivateKey, randomUUID } from "node:crypto";
import { createOutboundFetch, type OutboundFetch } from "@portikus/observability";
import { SignJWT } from "jose";
import { z } from "zod";
import { type LtiRole, mapLtiRoles } from "./roles.js";
import { toolKeyId } from "./tool-key.js";

/** The only scope the tool asks for: reading a course's member list. */
export const NRPS_SCOPE =
	"https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly";

// Limits on what an LMS can make one roster sync do (SPEC.md section 24).
export const NRPS_MAX_PAGES = 50;
export const NRPS_MAX_MEMBERS = 5000;
const NRPS_REQUEST_TIMEOUT_MS = 10_000;
const MAX_TOKEN_BODY_BYTES = 64 * 1024;
const MAX_PAGE_BODY_BYTES = 4 * 1024 * 1024;
const ASSERTION_LIFETIME_SECONDS = 300;

export type NrpsErrorKind =
	| "token_failed"
	| "http_error"
	| "bad_shape"
	| "cap_exceeded";

/**
 * Why a roster fetch failed. The message is fixed text: it never holds the
 * access token, a response body or a member's details (ADR 0012).
 */
export class NrpsError extends Error {
	constructor(
		readonly kind: NrpsErrorKind,
		message: string,
		/** The HTTP status, when the failure was an answer rather than no answer. */
		readonly status: number | null = null,
	) {
		super(message);
		this.name = "NrpsError";
	}
}

/** One course member as the roster reports it. Unknown fields are dropped. */
export interface NrpsMember {
	userId: string;
	name: string | null;
	roles: string[];
	/** The platform role the roles map to, as a launch would map them. */
	role: LtiRole;
	status: "Active" | "Inactive" | "Deleted";
}

const tokenSchema = z.object({ access_token: z.string().min(1).max(4096) });

const memberSchema = z.object({
	user_id: z.string().min(1).max(255),
	name: z.string().optional(),
	roles: z.array(z.string().max(255)).max(100),
	// NRPS: a member with no status is active.
	status: z.enum(["Active", "Inactive", "Deleted"]).optional(),
});

const pageSchema = z.object({ members: z.array(memberSchema) });

export interface NrpsTokenInput {
	/** The platform's OAuth 2 token endpoint. */
	tokenUrl: string;
	clientId: string;
	/** The tool's RSA private key in PEM form. */
	toolKeyPem: string;
	/** The forward proxy for outbound requests (ADR 0027); none in development. */
	proxyUrl?: string | null;
	now?: Date;
}

export interface NrpsMembershipsInput {
	/** The launch's `context_memberships_url`. */
	membershipsUrl: string;
	/** From {@link requestNrpsToken}. Never log it. */
	accessToken: string;
	proxyUrl?: string | null;
}

/** Read a body, giving up once it passes `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new NrpsError("cap_exceeded", `response body over ${maxBytes} bytes`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** One request with the per-request timeout and no redirects followed. */
async function send(
	outbound: OutboundFetch,
	url: string,
	init: RequestInit,
): Promise<Response | null> {
	try {
		return await outbound(url, {
			...init,
			redirect: "error",
			signal: AbortSignal.timeout(NRPS_REQUEST_TIMEOUT_MS),
		});
	} catch {
		return null;
	}
}

/**
 * Ask the platform for an access token with a signed client assertion
 * (the LTI Advantage client-credentials grant, RFC 7523), scoped to read
 * the roster only.
 */
export async function requestNrpsToken(input: NrpsTokenInput): Promise<string> {
	const kid = toolKeyId(input.toolKeyPem);
	const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
	const assertion = await new SignJWT({ jti: randomUUID() })
		.setProtectedHeader({ alg: "RS256", typ: "JWT", kid })
		.setIssuer(input.clientId)
		.setSubject(input.clientId)
		.setAudience(input.tokenUrl)
		.setIssuedAt(nowSeconds)
		.setExpirationTime(nowSeconds + ASSERTION_LIFETIME_SECONDS)
		.sign(createPrivateKey(input.toolKeyPem));
	const body = new URLSearchParams({
		grant_type: "client_credentials",
		client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
		client_assertion: assertion,
		scope: NRPS_SCOPE,
	});
	const response = await send(createOutboundFetch(input.proxyUrl), input.tokenUrl, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json",
		},
		body: body.toString(),
	});
	if (!response) throw new NrpsError("token_failed", "token endpoint did not answer");
	if (response.status !== 200) {
		await response.body?.cancel();
		throw new NrpsError("token_failed", "token endpoint refused", response.status);
	}
	let text: string;
	try {
		text = await readCapped(response, MAX_TOKEN_BODY_BYTES);
	} catch {
		throw new NrpsError("token_failed", "token response unreadable or too large");
	}
	const parsed = tokenSchema.safeParse(parseJson(text));
	if (!parsed.success) {
		throw new NrpsError("token_failed", "token response has no access token");
	}
	return parsed.data.access_token;
}

/** The `rel="next"` target of a Link header, resolved against the page it came on. */
export function nextLink(header: string | null, pageUrl: string): string | null {
	if (!header) return null;
	for (const match of header.matchAll(/<([^>]*)>([^,<]*)/g)) {
		const params = match[2] ?? "";
		const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(params);
		const values = (rel?.[1] ?? rel?.[2] ?? "").toLowerCase().split(/\s+/);
		if (values.includes("next")) {
			try {
				return new URL(match[1] ?? "", pageUrl).toString();
			} catch {
				return null;
			}
		}
	}
	return null;
}

function toMember(raw: z.infer<typeof memberSchema>): NrpsMember {
	const name = raw.name?.trim().slice(0, 255) ?? "";
	return {
		userId: raw.user_id,
		name: name === "" ? null : name,
		roles: raw.roles,
		role: mapLtiRoles(raw.roles),
		status: raw.status ?? "Active",
	};
}

/**
 * Every member of the course, following `Link: rel="next"` pages on the
 * memberships URL's own origin. Throws {@link NrpsError} on any failure, so
 * a caller applies a complete roster or nothing. A member listed twice is
 * kept once.
 */
export async function fetchNrpsMembers(
	input: NrpsMembershipsInput,
): Promise<NrpsMember[]> {
	const outbound = createOutboundFetch(input.proxyUrl);
	const origin = new URL(input.membershipsUrl).origin;
	const members = new Map<string, NrpsMember>();
	let seen = 0;
	let url: string | null = input.membershipsUrl;
	for (let page = 0; url !== null; page += 1) {
		if (page >= NRPS_MAX_PAGES) {
			throw new NrpsError(
				"cap_exceeded",
				`roster has more than ${NRPS_MAX_PAGES} pages`,
			);
		}
		const response = await send(outbound, url, {
			method: "GET",
			headers: {
				authorization: `Bearer ${input.accessToken}`,
				accept: "application/vnd.ims.lti-nrps.v2.membershipcontainer+json",
			},
		});
		if (!response) throw new NrpsError("http_error", "memberships did not answer");
		if (response.status !== 200) {
			await response.body?.cancel();
			throw new NrpsError("http_error", "memberships refused", response.status);
		}
		const parsed = pageSchema.safeParse(
			parseJson(await readCapped(response, MAX_PAGE_BODY_BYTES)),
		);
		if (!parsed.success) {
			throw new NrpsError("bad_shape", "memberships page is not a member list");
		}
		seen += parsed.data.members.length;
		if (seen > NRPS_MAX_MEMBERS) {
			throw new NrpsError(
				"cap_exceeded",
				`roster has more than ${NRPS_MAX_MEMBERS} members`,
			);
		}
		for (const raw of parsed.data.members) {
			if (!members.has(raw.user_id)) members.set(raw.user_id, toMember(raw));
		}
		url = nextLink(response.headers.get("link"), url);
		// The bearer token must never be sent to another host.
		if (url !== null && new URL(url).origin !== origin) {
			throw new NrpsError("bad_shape", "next page link leaves the memberships host");
		}
	}
	return [...members.values()];
}
