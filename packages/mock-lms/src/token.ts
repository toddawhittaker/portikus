import { randomUUID } from "node:crypto";
import { type CryptoKey, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import {
	CLIENT_ID,
	type Course,
	DEPLOYMENT_ID,
	type Person,
	ROLE_URIS,
	type RoleName,
} from "./seed.js";

// Each defect makes a launch wrong in exactly one way, so a test knows which check refused it.
export const DEFECTS = [
	"bad_signature",
	"wrong_aud",
	"expired",
	"replayed_nonce",
	"unknown_deployment",
	"wrong_message_type",
	"wrong_version",
	"alg_none",
	"wrong_target",
] as const;

export type Defect = (typeof DEFECTS)[number];

export function isDefect(value: string): value is Defect {
	return (DEFECTS as readonly string[]).includes(value);
}

const LTI = "https://purl.imsglobal.org/spec/lti/claim/";
const LIFETIME_SECONDS = 300;

export interface Signer {
	kid: string;
	privateKey: CryptoKey;
	// Signs bad_signature launches under the same kid, so only the signature is wrong.
	strangerKey: CryptoKey;
	jwks: { keys: JWK[] };
}

// A fresh key per process: nothing this mock signs outlives it.
export async function createSigner(): Promise<Signer> {
	const kid = randomUUID();
	const { privateKey, publicKey } = await generateKeyPair("RS256", {
		extractable: true,
	});
	const stranger = await generateKeyPair("RS256");
	const jwk = await exportJWK(publicKey);
	return {
		kid,
		privateKey,
		strangerKey: stranger.privateKey,
		jwks: { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] },
	};
}

export interface LaunchClaimsInput {
	issuer: string;
	toolUrl: string;
	person: Person;
	course: Course;
	role: RoleName;
	nonce: string;
	now: number;
	defect?: Defect;
}

export function launchClaims(input: LaunchClaimsInput): Record<string, unknown> {
	const { person, course, defect } = input;
	const iat = defect === "expired" ? input.now - 3600 : input.now;
	return {
		iss: input.issuer,
		sub: person.sub,
		aud: defect === "wrong_aud" ? "some-other-tool" : CLIENT_ID,
		iat,
		exp: iat + LIFETIME_SECONDS,
		nonce: input.nonce,
		name: `${person.givenName} ${person.familyName}`,
		given_name: person.givenName,
		family_name: person.familyName,
		email: person.email,
		...(person.preferredUsername && { preferred_username: person.preferredUsername }),
		...(person.customUsername && {
			[`${LTI}custom`]: { username: person.customUsername },
		}),
		[`${LTI}message_type`]:
			defect === "wrong_message_type"
				? "LtiDeepLinkingRequest"
				: "LtiResourceLinkRequest",
		[`${LTI}version`]: defect === "wrong_version" ? "1.1.0" : "1.3.0",
		[`${LTI}deployment_id`]:
			defect === "unknown_deployment" ? "unknown-deployment" : DEPLOYMENT_ID,
		[`${LTI}target_link_uri`]:
			defect === "wrong_target" ? "https://elsewhere.invalid/" : `${input.toolUrl}/`,
		[`${LTI}resource_link`]: { id: `${course.id}-portikus`, title: "Portikus" },
		[`${LTI}context`]: {
			id: course.id,
			label: course.label,
			title: course.title,
			type: ["http://purl.imsglobal.org/vocab/lis/v2/course#CourseOffering"],
		},
		[`${LTI}roles`]: [ROLE_URIS[input.role]],
	};
}

export async function signLaunch(
	signer: Signer,
	claims: Record<string, unknown>,
	defect?: Defect,
): Promise<string> {
	if (defect === "alg_none") {
		const encode = (value: object) =>
			Buffer.from(JSON.stringify(value)).toString("base64url");
		return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.`;
	}
	const key = defect === "bad_signature" ? signer.strangerKey : signer.privateKey;
	return new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", typ: "JWT", kid: signer.kid })
		.sign(key);
}
