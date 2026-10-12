import {
	type EntraRoleSource,
	type SigninProvider,
	SigninSettings,
	type SigninView,
	type SiteJobView,
} from "@portikus/contracts";

/** The single sign-on form (ADR 0059): what the page may choose, never LDAP. */
export interface SsoForm {
	provider: SigninProvider;
	entraTenantId: string;
	entraRoleSource: EntraRoleSource;
	/** Separated by spaces or commas, as the install question takes them. */
	googleDomains: string;
	/** Blank leaves Google groups unread; set, roles come from three groups. */
	googleAdminEmail: string;
	/** Write-only: the service-account key's JSON; blank keeps a stored one. */
	googleKey: string;
	oidcIssuer: string;
	clientId: string;
	/** Write-only: blank keeps the stored secret where the rules allow it. */
	clientSecret: string;
	groupsClaim: string;
	studentGroup: string;
	instructorGroup: string;
	adminGroup: string;
}

export const FIELD_ID: Record<Exclude<keyof SsoForm, "provider">, string> = {
	entraTenantId: "sso-entra-tenant",
	entraRoleSource: "sso-entra-role-source",
	googleDomains: "sso-google-domains",
	googleAdminEmail: "sso-google-admin",
	googleKey: "sso-google-key",
	oidcIssuer: "sso-oidc-issuer",
	clientId: "sso-client-id",
	clientSecret: "sso-client-secret",
	groupsClaim: "sso-groups-claim",
	studentGroup: "sso-group-student",
	instructorGroup: "sso-group-instructor",
	adminGroup: "sso-group-admin",
};

export const PROVIDER_LABEL: Record<SigninView["provider"], string> = {
	dex: "Local accounts only",
	entra: "Microsoft Entra ID",
	google: "Google Workspace",
	oidc: "Another OpenID Connect provider",
	ldap: "LDAP or Active Directory",
};

/** The install question's default group names. */
const DEFAULT_GROUPS = {
	student: "portikus-students",
	instructor: "portikus-instructors",
	admin: "portikus-administrators",
};

export function initialForm(view: SigninView | null): SsoForm {
	const groups = view?.groups ?? DEFAULT_GROUPS;
	return {
		provider: view && view.provider !== "ldap" ? view.provider : "dex",
		entraTenantId: view?.entraTenantId ?? "",
		entraRoleSource: view?.entraRoleSource ?? "appRoles",
		googleDomains: (view?.googleDomains ?? []).join(" "),
		googleAdminEmail: view?.googleAdminEmail ?? "",
		googleKey: "",
		oidcIssuer: view?.oidcIssuer ?? "",
		clientId: view?.clientId ?? "",
		clientSecret: "",
		groupsClaim: view?.groupsClaim ?? "groups",
		studentGroup: groups.student || DEFAULT_GROUPS.student,
		instructorGroup: groups.instructor || DEFAULT_GROUPS.instructor,
		adminGroup: groups.admin || DEFAULT_GROUPS.admin,
	};
}

function domains(text: string): string[] {
	return text.split(/[\s,]+/).filter((d) => d !== "");
}

function groups(form: SsoForm, lower: boolean) {
	const name = (value: string) => (lower ? value.trim().toLowerCase() : value.trim());
	return {
		student: name(form.studentGroup),
		instructor: name(form.instructorGroup),
		admin: name(form.adminGroup),
	};
}

/** Whether this form takes roles from three groups the provider names. */
export function usesGroups(form: SsoForm): boolean {
	if (form.provider === "oidc") return true;
	if (form.provider === "entra") return form.entraRoleSource === "groups";
	return form.provider === "google" && form.googleAdminEmail.trim() !== "";
}

/** The request body: only the chosen provider's fields. */
export function toSettings(form: SsoForm): SigninSettings {
	const secret = form.clientSecret === "" ? null : form.clientSecret;
	switch (form.provider) {
		case "dex":
			return { provider: "dex", clientSecret: null };
		case "entra":
			return {
				provider: "entra",
				entraTenantId: form.entraTenantId.trim(),
				clientId: form.clientId.trim(),
				clientSecret: secret,
				entraRoleSource: form.entraRoleSource,
				...(usesGroups(form) ? { groups: groups(form, false) } : {}),
			};
		case "google": {
			const google = {
				provider: "google" as const,
				googleDomains: domains(form.googleDomains),
				clientId: form.clientId.trim(),
				clientSecret: secret,
			};
			if (!usesGroups(form)) return google;
			// Google returns group emails in lowercase, and Dex matches them exactly.
			const key = form.googleKey.trim();
			return {
				...google,
				googleAdminEmail: form.googleAdminEmail.trim(),
				groups: groups(form, true),
				...(key === "" ? {} : { googleServiceAccountKey: key }),
			};
		}
		case "oidc":
			return {
				provider: "oidc",
				oidcIssuer: form.oidcIssuer.trim(),
				clientId: form.clientId.trim(),
				clientSecret: secret,
				groupsClaim: form.groupsClaim.trim(),
				groups: groups(form, false),
			};
	}
}

/**
 * Whether the stored secret cannot be kept: none is stored, or the provider,
 * tenant, issuer or client ID changes, so the old one would go to the wrong
 * place (ADR 0059). The API refuses the same case.
 */
export function secretRequired(form: SsoForm, view: SigninView | null): boolean {
	if (form.provider === "dex") return false;
	if (!view?.clientSecretSet || view.provider !== form.provider) return true;
	if (form.clientId.trim() !== (view.clientId ?? "")) return true;
	if (form.provider === "entra" && form.entraTenantId.trim() !== view.entraTenantId) {
		return true;
	}
	return form.provider === "oidc" && form.oidcIssuer.trim() !== view.oidcIssuer;
}

const MESSAGE: Record<Exclude<keyof SsoForm, "provider">, string> = {
	entraTenantId: "Enter the tenant ID, such as 12345678-90ab-cdef-1234-567890abcdef.",
	entraRoleSource: "Choose app roles or groups.",
	googleDomains: "Enter one or more domains, such as example.edu.",
	googleAdminEmail:
		"Enter the administrator's email address, such as admin@example.edu.",
	googleKey:
		"Paste the whole JSON key of a service account: type service_account, with a private key.",
	oidcIssuer: "Enter the issuer's https address, such as https://login.example.edu.",
	clientId: "Enter the client ID: letters, digits and . _ ~ : @ / + = - only.",
	clientSecret: "The client secret is at least 16 characters, with no braces.",
	groupsClaim: "Enter a claim name with no spaces or quotes, such as groups.",
	studentGroup:
		"Enter a group name that starts with a letter or digit and has no quotes.",
	instructorGroup:
		"Enter a group name that starts with a letter or digit and has no quotes.",
	adminGroup:
		"Enter a group name that starts with a letter or digit and has no quotes.",
};

/** What a group field needs where the provider names groups by ID or email. */
function groupMessage(
	form: SsoForm,
	field: Exclude<keyof SsoForm, "provider">,
): string {
	if (form.provider === "entra") {
		return "Enter the group's object ID, such as 12345678-90ab-cdef-1234-567890abcdef.";
	}
	if (form.provider === "google") {
		return "Enter the group's email address, such as portikus-students@example.edu.";
	}
	return MESSAGE[field];
}

const GROUP_FIELDS: readonly string[] = [
	"studentGroup",
	"instructorGroup",
	"adminGroup",
];

/** Where each request field is edited on the form. */
const FIELD_OF: Record<string, Exclude<keyof SsoForm, "provider">> = {
	entraTenantId: "entraTenantId",
	entraRoleSource: "entraRoleSource",
	googleDomains: "googleDomains",
	googleAdminEmail: "googleAdminEmail",
	googleServiceAccountKey: "googleKey",
	oidcIssuer: "oidcIssuer",
	clientId: "clientId",
	clientSecret: "clientSecret",
	groupsClaim: "groupsClaim",
	"groups.student": "studentGroup",
	"groups.instructor": "instructorGroup",
	"groups.admin": "adminGroup",
};

/** Problems keyed by the field's element ID, checked with the API's own schema. */
export function validate(
	form: SsoForm,
	view: SigninView | null,
): Record<string, string> {
	const errors: Record<string, string> = {};
	const parsed = SigninSettings.safeParse(toSettings(form));
	if (!parsed.success) {
		for (const issue of parsed.error.issues) {
			const path = issue.path.filter((p) => typeof p === "string").join(".");
			const field = FIELD_OF[path] ?? FIELD_OF[String(issue.path[0])];
			if (field && !(FIELD_ID[field] in errors)) {
				errors[FIELD_ID[field]] = GROUP_FIELDS.includes(field)
					? groupMessage(form, field)
					: MESSAGE[field];
			}
		}
	}
	if (form.provider === "google" && usesGroups(form) && form.googleKey.trim() === "") {
		if (!view?.googleKeySet) {
			errors[FIELD_ID.googleKey] =
				"Paste the service account's JSON key. Group checks need one, and none is stored.";
		}
	}
	if (form.clientSecret === "" && secretRequired(form, view)) {
		errors[FIELD_ID.clientSecret] =
			"Enter the client secret. A new provider, tenant, issuer or client ID never gets the old one.";
	}
	return errors;
}

/** The open sign-in trial, or null. */
export function openTrial(job: SiteJobView | null): SiteJobView | null {
	return job?.kind === "signin" && job.state === "trial" ? job : null;
}

/** "12:05" for the time left before `endsAt`, never below zero. */
export function timeLeft(endsAt: string, now: number): string {
	const seconds = Math.max(0, Math.floor((Date.parse(endsAt) - now) / 1000));
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}:${String(s).padStart(2, "0")}`;
}

/** The job's line on the page, in plain words. */
export function jobText(job: SiteJobView): string {
	switch (job.state) {
		case "queued":
			return "The change is waiting for the server to take it.";
		case "running":
			return "The server is applying the change. Setup can take a few minutes.";
		case "trial":
			return "The new sign-in settings are on trial.";
		case "kept":
			return "The new sign-in settings were kept.";
		case "reverted":
			if ((job.code as string | null) === "trial_superseded") {
				return "The trial ended because the settings were changed outside this page.";
			}
			return job.code === "trial_expired"
				? "Nobody kept the trial in time, so the earlier sign-in settings were put back."
				: job.code === "setup_failed"
					? "Setup failed, so the earlier sign-in settings were put back."
					: job.code === "api_unhealthy"
						? "Portikus did not answer after setup, so the earlier sign-in settings were put back."
						: "The trial was rolled back to the earlier sign-in settings.";
		case "done":
			return "Done.";
		case "failed":
			return failedText(job.code);
	}
}

function failedText(code: SiteJobView["code"]): string {
	switch (code) {
		case "missing_secret":
			return "Not applied: the client secret, or the Google service account's key, is needed.";
		case "not_apt_install":
			return "Not applied: this server was not installed with apt.";
		case "trial_open":
			return "Not applied: another change was on trial.";
		case "busy":
			return "Not applied: setup was already running.";
		case "invalid_value":
		case "invalid_request":
			return "Not applied: the server refused a value.";
		default:
			return "The change failed. Check the server's log.";
	}
}
