import { createPrivateKey, randomBytes } from "node:crypto";
import { SignJWT } from "jose";

/** One `ltiResourceLink` content item: the course link the LMS creates. */
export interface DeepLinkResourceLink {
	title: string;
	url: string;
	/** Custom parameters the LMS sends back on every launch of this link. */
	custom: Record<string, string>;
}

export interface DeepLinkingResponseInput {
	/** The tool's RSA private key in PEM form. */
	toolKeyPem: string;
	/** The `kid` of that key in the tool keyset, so the platform can find it. */
	kid: string;
	clientId: string;
	platformIssuer: string;
	deploymentId: string;
	/** The request's `data` value, echoed unchanged; null when it sent none. */
	data: string | null;
	contentItems: readonly DeepLinkResourceLink[];
	now?: Date;
}

const CLAIM = "https://purl.imsglobal.org/spec/lti/claim/";
const DL_CLAIM = "https://purl.imsglobal.org/spec/lti-dl/claim/";
const RESPONSE_LIFETIME_SECONDS = 300;

/**
 * The signed `LtiDeepLinkingResponse` JWT the instructor's browser posts to
 * the platform's return URL (LTI Deep Linking 2.0, ADR 0025). The tool is
 * the issuer and the platform the audience.
 */
export async function signDeepLinkingResponse(
	input: DeepLinkingResponseInput,
): Promise<string> {
	const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
	const claims: Record<string, unknown> = {
		nonce: randomBytes(16).toString("base64url"),
		[`${CLAIM}message_type`]: "LtiDeepLinkingResponse",
		[`${CLAIM}version`]: "1.3.0",
		[`${CLAIM}deployment_id`]: input.deploymentId,
		[`${DL_CLAIM}content_items`]: input.contentItems.map((item) => ({
			type: "ltiResourceLink",
			title: item.title,
			url: item.url,
			custom: { ...item.custom },
		})),
	};
	if (input.data !== null) claims[`${DL_CLAIM}data`] = input.data;
	return new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", typ: "JWT", kid: input.kid })
		.setIssuer(input.clientId)
		.setAudience(input.platformIssuer)
		.setIssuedAt(nowSeconds)
		.setExpirationTime(nowSeconds + RESPONSE_LIFETIME_SECONDS)
		.sign(createPrivateKey(input.toolKeyPem));
}
