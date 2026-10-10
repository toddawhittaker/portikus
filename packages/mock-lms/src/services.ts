import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JWTPayload } from "jose";
import { html, json, send } from "./http.js";
import { errorPage, savedLinksPage } from "./pages.js";
import { NRPS_SCOPE, type Rosters } from "./roster.js";
import { CLIENT_ID, COURSES, DEPLOYMENT_ID } from "./seed.js";
import type { ContentLink } from "./token.js";
import { type FetchToolKeys, verifyToolJwt } from "./tool.js";

const LTI = "https://purl.imsglobal.org/spec/lti/claim/";
const DL = "https://purl.imsglobal.org/spec/lti-dl/claim/";
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const MAX_REMEMBERED = 1000;
const TOKEN_SECONDS = 3600;

export interface ServicesOptions {
	issuer: string;
	fetchKeys: FetchToolKeys;
	now: () => number;
	rosters: Rosters;
	log: (line: string) => void;
}

/** Drop the oldest entry so a long-running mock stays bounded. */
function boundedAdd<T>(set: Set<T>, value: T) {
	if (set.size >= MAX_REMEMBERED) {
		const oldest = set.values().next().value;
		if (oldest !== undefined) set.delete(oldest);
	}
	set.add(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every((v) => typeof v === "string")
	);
}

/** Content items of a Deep Linking response, or null when any is malformed. */
function readItems(value: unknown, courseKey: string): ContentLink[] | null {
	if (!Array.isArray(value)) return null;
	const items: ContentLink[] = [];
	for (const raw of value as unknown[]) {
		const item = (raw ?? {}) as Record<string, unknown>;
		if (item.type !== "ltiResourceLink" || typeof item.url !== "string") return null;
		if (item.custom !== undefined && !isStringRecord(item.custom)) return null;
		items.push({
			id: randomUUID(),
			courseKey,
			title: typeof item.title === "string" ? item.title : "Untitled",
			url: item.url,
			custom: (item.custom as Record<string, string> | undefined) ?? {},
		});
	}
	return items;
}

/** The token endpoint, the roster endpoint and the Deep Linking return. */
export function createServices(options: ServicesOptions) {
	const { issuer, fetchKeys, now, rosters, log } = options;
	const accessTokens = new Set<string>();
	const seenAssertions = new Set<string>();
	// Deep Linking `data` values handed out, and the course each belongs to.
	const deepLinkData = new Map<string, string>();
	const links = new Map<string, ContentLink>();

	const tokenError = (res: ServerResponse, status: number, error: string) =>
		json(res, status, { error });

	async function token(params: URLSearchParams, res: ServerResponse) {
		if (params.get("grant_type") !== "client_credentials") {
			return tokenError(res, 400, "unsupported_grant_type");
		}
		if (params.get("client_assertion_type") !== ASSERTION_TYPE) {
			return tokenError(res, 400, "invalid_request");
		}
		let payload: JWTPayload;
		try {
			payload = await verifyToolJwt(
				fetchKeys,
				params.get("client_assertion") ?? "",
				`${issuer}/token`,
				now(),
				["exp", "jti", "sub"],
			);
		} catch {
			return tokenError(res, 401, "invalid_client");
		}
		const jti = String(payload.jti);
		if (payload.sub !== CLIENT_ID || seenAssertions.has(jti)) {
			return tokenError(res, 401, "invalid_client");
		}
		boundedAdd(seenAssertions, jti);
		if (!(params.get("scope") ?? "").split(" ").includes(NRPS_SCOPE)) {
			return tokenError(res, 400, "invalid_scope");
		}
		const accessToken = randomBytes(32).toString("base64url");
		boundedAdd(accessTokens, accessToken);
		log("token issued");
		return json(res, 200, {
			access_token: accessToken,
			token_type: "Bearer",
			expires_in: TOKEN_SECONDS,
			scope: NRPS_SCOPE,
		});
	}

	function memberships(req: IncomingMessage, url: URL, res: ServerResponse) {
		const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
		if (!bearer || !accessTokens.has(bearer)) {
			return send(res, 401, "text/plain; charset=utf-8", "Unauthorized\n");
		}
		const courseId = /^\/nrps\/([^/]+)\/memberships$/.exec(url.pathname)?.[1];
		const course = COURSES.find((c) => c.id === courseId);
		const page = course
			? rosters.page(
					issuer,
					course.key,
					url.searchParams.get("page"),
					url.searchParams.get("limit"),
				)
			: undefined;
		if (!page) return send(res, 404, "text/plain; charset=utf-8", "Not found\n");
		if (page.next) res.setHeader("link", `<${page.next}>; rel="next"`);
		return send(
			res,
			200,
			"application/vnd.ims.lti-nrps.v2.membershipcontainer+json",
			JSON.stringify(page.body),
		);
	}

	/** A new `data` value for a Deep Linking request in a course. */
	function newDeepLinkData(courseKey: string): string {
		const data = randomUUID();
		if (deepLinkData.size >= MAX_REMEMBERED) {
			const oldest = deepLinkData.keys().next().value;
			if (oldest !== undefined) deepLinkData.delete(oldest);
		}
		deepLinkData.set(data, courseKey);
		return data;
	}

	async function deepLinkReturn(params: URLSearchParams, res: ServerResponse) {
		const refuse = (message: string) => html(res, 400, errorPage(message));
		let payload: JWTPayload;
		try {
			payload = await verifyToolJwt(fetchKeys, params.get("JWT") ?? "", issuer, now(), [
				"exp",
			]);
		} catch {
			return refuse("The Deep Linking response is not signed by the tool.");
		}
		if (payload[`${LTI}message_type`] !== "LtiDeepLinkingResponse") {
			return refuse("message_type must be LtiDeepLinkingResponse.");
		}
		if (payload[`${LTI}version`] !== "1.3.0") return refuse("version must be 1.3.0.");
		if (payload[`${LTI}deployment_id`] !== DEPLOYMENT_ID) {
			return refuse("deployment_id is not this mock's.");
		}
		const courseKey = deepLinkData.get(String(payload[`${DL}data`] ?? ""));
		if (!courseKey) return refuse("data names no Deep Linking request started here.");
		const items = readItems(payload[`${DL}content_items`], courseKey);
		if (!items) return refuse("content_items is not a list of resource links.");
		for (const link of items) links.set(link.id, link);
		log(`deeplink stored count=${items.length}`);
		return html(res, 200, savedLinksPage(items.length));
	}

	return { token, memberships, newDeepLinkData, deepLinkReturn, links };
}
