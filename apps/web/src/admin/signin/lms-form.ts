import {
	AdminLtiPlatform,
	MAX_ADMIN_LTI_PLATFORMS,
	type OperatorLtiPlatform,
} from "@portikus/contracts";

/** What the dialog edits: every field as text. */
export interface LmsDraft {
	name: string;
	issuer: string;
	clientId: string;
	authLoginUrl: string;
	keysetUrl: string;
	authTokenUrl: string;
	/** One deployment ID per line. */
	deploymentIds: string;
}

export type LmsField = keyof LmsDraft;
export type LmsErrors = Partial<Record<LmsField, string>>;

export const EMPTY_DRAFT: LmsDraft = {
	name: "",
	issuer: "",
	clientId: "",
	authLoginUrl: "",
	keysetUrl: "",
	authTokenUrl: "",
	deploymentIds: "",
};

export function draftOf(platform: AdminLtiPlatform): LmsDraft {
	return {
		...platform,
		authTokenUrl: platform.authTokenUrl ?? "",
		deploymentIds: platform.deploymentIds.join("\n"),
	};
}

function toPlatform(draft: LmsDraft) {
	const authTokenUrl = draft.authTokenUrl.trim();
	return {
		name: draft.name.trim(),
		issuer: draft.issuer.trim(),
		clientId: draft.clientId.trim(),
		authLoginUrl: draft.authLoginUrl.trim(),
		keysetUrl: draft.keysetUrl.trim(),
		...(authTokenUrl ? { authTokenUrl } : {}),
		deploymentIds: draft.deploymentIds
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== ""),
		mock: false as const,
	};
}

const REQUIRED: Partial<Record<LmsField, string>> = {
	name: "Enter a name.",
	issuer: "Enter the issuer address.",
	clientId: "Enter the client ID.",
	authLoginUrl: "Enter the login address.",
	keysetUrl: "Enter the keyset address.",
	deploymentIds: "Enter at least one deployment ID.",
};

/**
 * The platform the draft describes, or the problems with it: the contracts'
 * own rules, plus a clash with another platform or with the operator's.
 */
export function checkDraft(
	draft: LmsDraft,
	others: AdminLtiPlatform[],
	operator: OperatorLtiPlatform[],
): { platform: AdminLtiPlatform } | { errors: LmsErrors } {
	const platform = toPlatform(draft);
	const errors: LmsErrors = {};
	for (const [field, message] of Object.entries(REQUIRED) as [LmsField, string][]) {
		const empty =
			field === "deploymentIds"
				? platform.deploymentIds.length === 0
				: !platform[field];
		if (empty) errors[field] = message;
	}
	const parsed = AdminLtiPlatform.safeParse(platform);
	if (!parsed.success) {
		for (const issue of parsed.error.issues) {
			const field = issue.path[0] as LmsField | undefined;
			if (field && !(field in errors)) errors[field] = `Not valid: ${issue.message}.`;
		}
	}
	const taken = [...others, ...operator];
	if (taken.some((p) => p.name === platform.name) && !errors.name) {
		errors.name = "Another platform already has this name.";
	}
	if (
		taken.some(
			(p) => p.issuer === platform.issuer && p.clientId === platform.clientId,
		) &&
		!errors.clientId
	) {
		errors.clientId =
			"A platform with this issuer and client ID is already registered.";
	}
	if (others.length + 1 > MAX_ADMIN_LTI_PLATFORMS) {
		errors.name = `At most ${MAX_ADMIN_LTI_PLATFORMS} platforms can be registered here.`;
	}
	return Object.keys(errors).length > 0 || !parsed.success
		? { errors }
		: { platform: parsed.data };
}
