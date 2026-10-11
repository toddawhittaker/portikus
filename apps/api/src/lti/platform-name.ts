import type { LtiDeps } from "./deps.js";

/** The LTI registration's name, or the issuer's host when it is no longer registered. */
export function platformNameOf(
	lti: LtiDeps | undefined,
	platformIssuer: string,
): string {
	const registered = lti?.platforms.find((p) => p.issuer === platformIssuer);
	if (registered) return registered.name;
	return URL.canParse(platformIssuer) ? new URL(platformIssuer).host : platformIssuer;
}
