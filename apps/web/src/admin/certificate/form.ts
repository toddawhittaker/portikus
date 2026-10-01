import {
	ACME_DIRECTORY_PRESETS,
	type AcmeDirectoryPreset,
	type CertificateJobView,
	type CertificateSettings,
	type CertificateSettingsView,
	type CertificateSource,
	type CertificateUploadCheck,
	DNS_PROVIDER_FIELDS,
	type DnsChallenge,
	type DnsProvider,
	MAX_PEM_LENGTH,
	MAX_SERVICE_ACCOUNT_JSON,
	type PreflightCheck,
} from "@portikus/contracts";

/**
 * The Certificate tab's form, kept apart from React so its rules are unit
 * tested (docs/SPEC.md section 20.1; ADR 0046). Secrets are write-only: the
 * form starts with every secret blank, and a blank secret is left out of the
 * request so the job keeps the stored one.
 */

export type DirectoryChoice = AcmeDirectoryPreset | "custom";
export type ChallengeMode = "dns01" | "http01";

/** One uploaded certificate: the text of each chosen file, "" when none was chosen. */
export interface UploadDraft {
	certificate: string;
	chain: string;
	privateKey: string;
}

export interface CertificateForm {
	source: CertificateSource;
	directory: DirectoryChoice;
	customDirectory: string;
	email: string;
	eabKeyId: string;
	eabHmacKey: string;
	mode: ChallengeMode;
	provider: DnsProvider;
	/** Keyed `provider.field`, so one provider's values never leak into another's. */
	plain: Record<string, string>;
	secrets: Record<string, string>;
	site: UploadDraft;
	separatePreview: boolean;
	preview: UploadDraft;
}

export const SOURCE_LABEL: Record<CertificateSource, string> = {
	internal: "Internal authority",
	acme: "ACME (Let's Encrypt and others)",
	files: "Uploaded files",
};

export const DIRECTORY_LABEL: Record<DirectoryChoice, string> = {
	letsencrypt: "Let's Encrypt",
	"letsencrypt-staging": "Let's Encrypt staging",
	zerossl: "ZeroSSL",
	custom: "Another ACME directory",
};

export const DIRECTORY_CHOICES: readonly DirectoryChoice[] = [
	"letsencrypt",
	"letsencrypt-staging",
	"zerossl",
	"custom",
];

export const PROVIDER_LABEL: Record<DnsProvider, string> = {
	cloudflare: "Cloudflare",
	route53: "Amazon Route 53",
	digitalocean: "DigitalOcean",
	ovh: "OVH",
	hetzner: "Hetzner Cloud DNS",
	gandi: "Gandi",
	porkbun: "Porkbun",
	googleclouddns: "Google Cloud DNS",
	azure: "Azure DNS",
};

export const PROVIDERS = Object.keys(DNS_PROVIDER_FIELDS) as DnsProvider[];

const FIELD_LABEL: Record<string, string> = {
	api_token: "API token",
	region: "Region",
	access_key_id: "Access key ID",
	secret_access_key: "Secret access key",
	auth_token: "API token",
	endpoint: "Endpoint",
	application_key: "Application key",
	application_secret: "Application secret",
	consumer_key: "Consumer key",
	bearer_token: "Personal access token",
	api_key: "API key",
	api_secret_key: "Secret API key",
	gcp_project: "Project ID",
	service_account_json: "Service account key (JSON)",
	tenant_id: "Tenant ID",
	client_id: "Client ID",
	subscription_id: "Subscription ID",
	resource_group_name: "Resource group",
	client_secret: "Client secret",
};

/** A provider field's label; a name the table does not know yet reads as words. */
export function fieldLabel(name: string): string {
	const known = FIELD_LABEL[name];
	if (known) return known;
	const words = name.replace(/_/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

export const PREFLIGHT_LABEL: Record<PreflightCheck["name"], string> = {
	"dns-site": "The site's name resolves",
	"dns-preview": "Preview names resolve",
	"reach-site": "The site's name reaches this server",
	"reach-preview": "Preview names reach this server",
	"http-port-80": "Port 80 answers",
};

export const KIND_LABEL: Record<NonNullable<CertificateJobView["kind"]>, string> = {
	test: "Test only",
	apply: "Apply",
	renew: "Renew now",
	rollback: "Roll back",
	check: "Check the certificate",
	reset: "Reset to the internal authority",
};

export const STATE_LABEL: Record<CertificateJobView["state"], string> = {
	queued: "Waiting to start",
	running: "Running",
	succeeded: "Finished",
	failed: "Failed",
	refused: "Refused",
};

const key = (provider: DnsProvider, field: string) => `${provider}.${field}`;

export function directoryChoice(url: string): DirectoryChoice {
	for (const choice of DIRECTORY_CHOICES) {
		if (choice !== "custom" && ACME_DIRECTORY_PRESETS[choice] === url) return choice;
	}
	return "custom";
}

export function directoryUrl(form: CertificateForm): string {
	return form.directory === "custom"
		? form.customDirectory.trim()
		: ACME_DIRECTORY_PRESETS[form.directory];
}

/**
 * Whether Test only issues a real certificate (Epic 27 R11 as amended):
 * Let's Encrypt is tested against its staging service, every other
 * directory against itself.
 */
export function testIsReal(form: CertificateForm): boolean {
	return form.directory === "zerossl" || form.directory === "custom";
}

const NO_UPLOAD: UploadDraft = { certificate: "", chain: "", privateKey: "" };

/** The form as the settings in force leave it, every secret blank. */
export function initialForm(settings: CertificateSettingsView | null): CertificateForm {
	const form: CertificateForm = {
		source: settings?.source ?? "internal",
		directory: "letsencrypt",
		customDirectory: "",
		email: "",
		eabKeyId: "",
		eabHmacKey: "",
		mode: "dns01",
		provider: "cloudflare",
		plain: {},
		secrets: {},
		site: NO_UPLOAD,
		separatePreview: false,
		preview: NO_UPLOAD,
	};
	if (settings?.source === "acme") {
		form.directory = directoryChoice(settings.directory);
		if (form.directory === "custom") form.customDirectory = settings.directory;
		form.email = settings.email;
		form.eabKeyId = settings.eab?.keyId ?? "";
		form.mode = settings.challenge.mode;
		if (settings.challenge.mode === "dns01") {
			const { provider, fields } = settings.challenge;
			form.provider = provider;
			for (const [name, value] of Object.entries(fields)) {
				form.plain[key(provider, name)] = value;
			}
		}
	}
	if (settings?.source === "files") form.separatePreview = settings.preview !== null;
	return form;
}

export function plainValue(form: CertificateForm, field: string): string {
	return form.plain[key(form.provider, field)] ?? "";
}

export function secretValue(form: CertificateForm, field: string): string {
	return form.secrets[key(form.provider, field)] ?? "";
}

export function withPlain(form: CertificateForm, field: string, value: string) {
	return { ...form, plain: { ...form.plain, [key(form.provider, field)]: value } };
}

export function withSecret(form: CertificateForm, field: string, value: string) {
	return { ...form, secrets: { ...form.secrets, [key(form.provider, field)]: value } };
}

/** Whether the settings in force hold this provider secret, so a blank field keeps it. */
export function secretStored(
	settings: CertificateSettingsView | null,
	provider: DnsProvider,
	field: string,
): boolean {
	return (
		settings?.source === "acme" &&
		settings.challenge.mode === "dns01" &&
		settings.challenge.provider === provider &&
		settings.challenge.secretsSet[field] === true
	);
}

export function hmacStored(settings: CertificateSettingsView | null): boolean {
	return settings?.source === "acme" && settings.eab?.hmacKeySet === true;
}

export function keyStored(
	settings: CertificateSettingsView | null,
	which: "site" | "preview",
): boolean {
	if (settings?.source !== "files") return false;
	return which === "site"
		? settings.site.privateKeySet
		: settings.preview?.privateKeySet === true;
}

/** Field ids, which are also the keys of the error map. */
export const FIELD_ID = {
	email: "cert-email",
	customDirectory: "cert-directory-url",
	eabKeyId: "cert-eab-key-id",
	eabHmacKey: "cert-eab-hmac",
	provider: (field: string) => `cert-dns-${field}`,
	upload: (which: "site" | "preview", part: keyof UploadDraft) =>
		`cert-${which}-${part === "privateKey" ? "key" : part}`,
} as const;

const PLAIN = /^[A-Za-z0-9._:/@-]+$/;
const EAB_KEY_ID = /^[A-Za-z0-9_-]+$/;
const EAB_HMAC = /^[A-Za-z0-9_=-]+$/;

/** Longest one-line secret the contract accepts. */
const MAX_SECRET = 1024;

/**
 * Why a DNS secret cannot be sent, or null. Blank is fine when one is
 * stored. Google's service account key is JSON text; every other secret
 * is one line.
 */
export function secretProblem(
	name: string,
	value: string,
	stored: boolean,
): string | null {
	if (value === "") return stored ? null : `Enter the ${fieldLabel(name)}.`;
	if (name === "service_account_json") {
		if (value.length > MAX_SERVICE_ACCOUNT_JSON) return "The key is larger than 16 KB.";
		try {
			const parsed: unknown = JSON.parse(value);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				return null;
			}
		} catch {
			// Falls through to the message below.
		}
		return "Paste the whole JSON key file, from the opening { to the closing }.";
	}
	if (/[\r\n]/.test(value)) return "Enter it on one line.";
	if (value.length > MAX_SECRET) return "This is longer than 1,024 characters.";
	return null;
}

const CHECK_LABEL: Record<CertificateUploadCheck, string> = {
	"certificate-readable": "Certificate is readable",
	"key-readable": "Private key is readable",
	"key-matches": "Key matches the certificate",
	"chain-complete": "Chain is complete",
	"dates-valid": "Dates are valid",
	"names-cover": "Names cover the site",
};

/**
 * The API names a refused upload's check by its id ("the key-matches check
 * failed"); the page names it in words (Epic 27 R9).
 */
export function uploadRefusalText(message: string): string {
	return message.replace(/the ([a-z-]+) check failed\./, (whole, id: string) => {
		const label = CHECK_LABEL[id as CertificateUploadCheck];
		return label ? `failed the check "${label}".` : whole;
	});
}

/** Why a chosen file cannot be used, or null. "" means no file was chosen. */
export function pemProblem(text: string): string | null {
	if (text === "") return null;
	if (text.length > MAX_PEM_LENGTH)
		return "This file is larger than 64 KB. Choose a PEM file.";
	if (!text.includes("-----BEGIN ")) {
		return "This file is not in PEM format. Choose a file that starts with -----BEGIN.";
	}
	return null;
}

function checkUpload(
	errors: Record<string, string>,
	which: "site" | "preview",
	draft: UploadDraft,
	settings: CertificateSettingsView | null,
) {
	const cert = FIELD_ID.upload(which, "certificate");
	if (draft.certificate === "") errors[cert] = "Choose the certificate file.";
	for (const part of ["certificate", "chain", "privateKey"] as const) {
		const problem = pemProblem(draft[part]);
		if (problem) errors[FIELD_ID.upload(which, part)] = problem;
	}
	if (draft.privateKey === "" && !keyStored(settings, which)) {
		errors[FIELD_ID.upload(which, "privateKey")] = "Choose the private key file.";
	}
}

/** Every problem the page can see before asking the API, keyed by field id. */
export function validate(
	form: CertificateForm,
	settings: CertificateSettingsView | null,
): Record<string, string> {
	const errors: Record<string, string> = {};
	if (form.source === "acme") {
		if (form.directory === "custom") {
			const url = form.customDirectory.trim();
			if (url === "") errors[FIELD_ID.customDirectory] = "Enter the directory URL.";
			else if (!/^https:\/\/[^\s/]+/.test(url)) {
				errors[FIELD_ID.customDirectory] =
					"The directory URL must start with https://.";
			}
		}
		const email = form.email.trim();
		if (email === "") errors[FIELD_ID.email] = "Enter the account email.";
		else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			errors[FIELD_ID.email] = "Enter an email address, such as it@example.edu.";
		}
		const keyId = form.eabKeyId.trim();
		if (keyId !== "" && !EAB_KEY_ID.test(keyId)) {
			errors[FIELD_ID.eabKeyId] = "Use only letters, digits, - and _.";
		}
		const hmac = form.eabHmacKey.trim();
		if (hmac !== "" && keyId === "") {
			errors[FIELD_ID.eabKeyId] = "Enter the key ID that goes with the HMAC key.";
		}
		if (hmac !== "" && !EAB_HMAC.test(hmac)) {
			errors[FIELD_ID.eabHmacKey] = "Use the key exactly as the authority gave it.";
		}
		if (keyId !== "" && hmac === "" && !hmacStored(settings)) {
			errors[FIELD_ID.eabHmacKey] = "Enter the HMAC key.";
		}
		if (form.mode === "dns01") {
			const fields = DNS_PROVIDER_FIELDS[form.provider];
			for (const name of fields.plain) {
				const value = plainValue(form, name).trim();
				if (value === "")
					errors[FIELD_ID.provider(name)] = `Enter the ${fieldLabel(name)}.`;
				else if (!PLAIN.test(value)) {
					errors[FIELD_ID.provider(name)] =
						"Use only letters, digits and . _ : / @ -, with no spaces.";
				}
			}
			for (const name of fields.secret) {
				const problem = secretProblem(
					name,
					secretValue(form, name),
					secretStored(settings, form.provider, name),
				);
				if (problem) errors[FIELD_ID.provider(name)] = problem;
			}
		}
	}
	if (form.source === "files") {
		checkUpload(errors, "site", form.site, settings);
		if (form.separatePreview) checkUpload(errors, "preview", form.preview, settings);
	}
	return errors;
}

function joinPem(...parts: string[]): string {
	return parts
		.map((part) => part.trim())
		.filter((part) => part !== "")
		.join("\n")
		.concat("\n");
}

function uploaded(draft: UploadDraft) {
	return {
		certificate: joinPem(draft.certificate, draft.chain),
		...(draft.privateKey === "" ? {} : { privateKey: draft.privateKey }),
	};
}

/** The settings to send. Call only once `validate` found nothing. */
export function toSettings(form: CertificateForm): CertificateSettings {
	if (form.source === "internal") return { source: "internal" };
	if (form.source === "files") {
		return {
			source: "files",
			site: uploaded(form.site),
			...(form.separatePreview ? { preview: uploaded(form.preview) } : {}),
		};
	}
	const keyId = form.eabKeyId.trim();
	const hmac = form.eabHmacKey.trim();
	const fields: Record<string, string> = {};
	const names = DNS_PROVIDER_FIELDS[form.provider];
	for (const name of names.plain) fields[name] = plainValue(form, name).trim();
	for (const name of names.secret) {
		const value = secretValue(form, name);
		if (value !== "") fields[name] = value;
	}
	return {
		source: "acme",
		directory: directoryUrl(form),
		email: form.email.trim(),
		...(keyId === ""
			? {}
			: { eab: { keyId, ...(hmac === "" ? {} : { hmacKey: hmac }) } }),
		challenge:
			form.mode === "http01"
				? { mode: "http01" }
				: // Built from DNS_PROVIDER_FIELDS, so the names match; the API parses it again.
					{ mode: "dns01", dns: { provider: form.provider, fields } as DnsChallenge },
	};
}

/** One line on what is in force, such as "ACME with Let's Encrypt, DNS-01 through Cloudflare". */
export function settingsText(settings: CertificateSettingsView): string {
	if (settings.source === "internal") return "Internal authority";
	if (settings.source === "files") return "Uploaded files";
	const choice = directoryChoice(settings.directory);
	const where = choice === "custom" ? settings.directory : DIRECTORY_LABEL[choice];
	const how =
		settings.challenge.mode === "http01"
			? "HTTP-01"
			: `DNS-01 through ${PROVIDER_LABEL[settings.challenge.provider]}`;
	return `ACME with ${where}, ${how}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How close an expiry is; "soon" is the 14 days before it (Epic 27 R12). */
export function expiry(
	notAfter: string,
	now: Date,
	warningDays: number,
): { days: number; tone: "ok" | "soon" | "expired" } {
	const left = Date.parse(notAfter) - now.getTime();
	const days = Math.floor(left / DAY_MS);
	if (left <= 0) return { days, tone: "expired" };
	return { days, tone: left < warningDays * DAY_MS ? "soon" : "ok" };
}

export function daysText(days: number): string {
	if (days < 0) return days === -1 ? "1 day ago" : `${-days} days ago`;
	if (days === 0) return "in less than a day";
	return days === 1 ? "in 1 day" : `in ${days} days`;
}
