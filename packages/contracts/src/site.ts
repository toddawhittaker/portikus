import { z } from "zod";
import { Role } from "./auth.js";
import type { CertificateSource } from "./certificate.js";
import { isHostName } from "./host-name.js";

/**
 * The root site job and the admin pages it serves (ADR 0059): page-added
 * proxy hosts and LMS platforms, the site address and the sign-in
 * provider. The API writes request files and reads status and view files;
 * the job checks every value again before it changes the host.
 */

// ---- Value rules ----

/**
 * Every free-text value reaches a root Ansible run, so braces (a template's
 * delimiters) and control characters are refused everywhere (ADR 0059).
 */
export function isSiteText(value: string): boolean {
	for (const c of value) {
		const code = c.codePointAt(0) ?? 0;
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
		if (c === "{" || c === "}") return false;
	}
	return true;
}

const SiteText = (max: number) =>
	z.string().max(max).refine(isSiteText, "must not hold braces or control characters");

/** Site text that also matches `pattern`, the field's own rule. */
const SiteField = (max: number, pattern: RegExp, message: string) =>
	SiteText(max).regex(pattern, message);

// The debconf question's host-name rule: lowercase, at least one dot.
const SITE_HOST_RE =
	/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A full host name for the site or a Google domain; never an address. */
export const SiteHostName = SiteText(253).refine(
	(value) => SITE_HOST_RE.test(value) && isHostName(value),
	"must be a lowercase host name such as portikus.example.edu",
);

/** A host the API may reach through the egress proxy, the ADR 0052 rule. */
export const ProxyHostName = SiteText(253).refine(
	isHostName,
	"must be a host name, not an address",
);

/**
 * An https URL with a host name. `defaultPort` also refuses an explicit
 * port, for hosts the egress proxy opens on 443 only (ADR 0059).
 */
const HttpsUrl = (defaultPort: boolean) =>
	SiteText(500).refine((value) => {
		if (!value.startsWith("https://")) return false;
		try {
			const url = new URL(value);
			return (
				url.username === "" &&
				url.password === "" &&
				isHostName(url.hostname) &&
				(!defaultPort || url.port === "")
			);
		} catch {
			return false;
		}
	}, "must be an https URL with a host name");

const Identifier = SiteField(
	255,
	/^[A-Za-z0-9._~:@/+=-]+$/,
	"must be letters, digits and . _ ~ : @ / + = - only",
);

const GroupName = SiteField(
	200,
	/^[A-Za-z0-9][A-Za-z0-9 ._:@/=,()+-]*$/,
	"must start with a letter or digit and hold no quotes",
);

const TenantId = z
	.string()
	.regex(
		/^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/,
		"must look like 12345678-90ab-cdef-1234-567890abcdef",
	);

const OidcIssuer = SiteField(
	500,
	/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[^\s?#]*)?$/,
	"must be an https address such as https://login.example.edu/realms/main",
);

const GroupsClaim = SiteField(
	100,
	/^[A-Za-z0-9_.:/-]+$/,
	"must be a claim name such as groups",
);

/** Write-only: it goes to secrets.yaml and never comes back out (SPEC.md 24.8). */
const ClientSecret = SiteText(500).refine(
	(value) => value.length >= 16,
	"must be at least 16 characters",
);

// ---- Limits ----

/** At most this many page-added proxy hosts (ADR 0059). */
export const MAX_PROXY_HOSTS = 50;
/** At most this many page-registered LMS platforms (ADR 0059). */
export const MAX_ADMIN_LTI_PLATFORMS = 20;

/**
 * Loopback ports the platform's own services use, which the site may not
 * move to (ADR 0059). The root site job holds the same list.
 */
export const SITE_RESERVED_PORTS: readonly number[] = [
	3000, 3001, 3128, 3129, 3130, 3199, 5000, 5001, 5300, 5398, 5399, 5432, 5556, 5557,
	7400, 8792, 8796,
];

/** 443, or a port from 1024 to 65535 that no platform service holds. */
export function isSitePort(port: number): boolean {
	if (!Number.isInteger(port)) return false;
	if (port === 443) return true;
	return port >= 1024 && port <= 65535 && !SITE_RESERVED_PORTS.includes(port);
}

export const SitePort = z
	.number()
	.int()
	.refine(isSitePort, "must be 443, or 1024 to 65535 and not a port Portikus uses");

function unique(values: readonly string[]): boolean {
	return new Set(values).size === values.length;
}

// ---- Page-added proxy hosts ----

/** `PUT /admin/proxy-hosts`: the whole page-owned list, which replaces the old one. */
export const ProxyHostsUpdate = z
	.object({
		hosts: z
			.array(ProxyHostName)
			.max(MAX_PROXY_HOSTS)
			.refine(unique, "must not repeat a host"),
	})
	.strict();
export type ProxyHostsUpdate = z.infer<typeof ProxyHostsUpdate>;

// ---- Page-registered LMS platforms ----

/**
 * One LMS platform the page registers: the platforms-file version 1 shape
 * (ADR 0025), HTTPS only and never a mock (ADR 0059).
 */
export const AdminLtiPlatform = z
	.object({
		name: SiteText(60).refine((value) => value.trim() !== "", "is required"),
		issuer: HttpsUrl(false),
		clientId: Identifier,
		authLoginUrl: HttpsUrl(false),
		/** The egress proxy opens its host on 443 only. */
		keysetUrl: HttpsUrl(true),
		/** Where the tool asks the platform for a token; its host is opened on 443 too. */
		authTokenUrl: HttpsUrl(true).optional(),
		deploymentIds: z.array(Identifier).min(1).max(20),
		mock: z.literal(false),
	})
	.strict();
export type AdminLtiPlatform = z.infer<typeof AdminLtiPlatform>;

/** `PUT /admin/lms`: the whole page-owned list, which replaces the old one. */
export const LtiPlatformsUpdate = z
	.object({
		platforms: z
			.array(AdminLtiPlatform)
			.max(MAX_ADMIN_LTI_PLATFORMS)
			.refine((list) => unique(list.map((p) => p.name)), "must not repeat a name")
			.refine(
				(list) => unique(list.map((p) => JSON.stringify([p.issuer, p.clientId]))),
				"must not repeat an issuer and client ID",
			),
	})
	.strict();
export type LtiPlatformsUpdate = z.infer<typeof LtiPlatformsUpdate>;

/** An operator's platform as the page shows it, read-only; it may be a mock. */
export const OperatorLtiPlatform = z
	.object({
		name: z.string(),
		issuer: z.string(),
		clientId: z.string(),
		authLoginUrl: z.string(),
		keysetUrl: z.string(),
		authTokenUrl: z.string().optional(),
		deploymentIds: z.array(z.string()),
		mock: z.boolean(),
	})
	.strict();
export type OperatorLtiPlatform = z.infer<typeof OperatorLtiPlatform>;

// ---- Site address ----

/** The body of the address plan, pre-flight and apply routes. */
export const AddressSettings = z
	.object({ host: SiteHostName, port: SitePort })
	.strict();
export type AddressSettings = z.infer<typeof AddressSettings>;

// ---- Sign-in provider ----

/** What the page may choose. LDAP is set only with `dpkg-reconfigure portikus` (ADR 0059). */
export const SigninProvider = z.enum(["dex", "entra", "google", "oidc"]);
export type SigninProvider = z.infer<typeof SigninProvider>;

export const SigninGroups = z
	.object({ student: GroupName, instructor: GroupName, admin: GroupName })
	.strict();
export type SigninGroups = z.infer<typeof SigninGroups>;

const SigninFields = {
	provider: SigninProvider,
	entraTenantId: TenantId.optional(),
	googleDomains: z
		.array(SiteHostName)
		.min(1)
		.max(20)
		.refine(unique, "must not repeat a domain")
		.optional(),
	oidcIssuer: OidcIssuer.optional(),
	clientId: Identifier.optional(),
	clientSecret: ClientSecret.nullable(),
	groupsClaim: GroupsClaim.optional(),
	groups: SigninGroups.optional(),
};

/** The fields each provider needs; "dex" needs none. */
const NEEDS = {
	dex: [],
	entra: ["entraTenantId", "clientId"],
	google: ["googleDomains", "clientId"],
	oidc: ["oidcIssuer", "clientId"],
} as const satisfies Record<SigninProvider, ReadonlyArray<keyof typeof SigninFields>>;

function checkSignin(
	settings: { provider: SigninProvider; clientSecret: string | null } & Partial<
		Record<string, unknown>
	>,
	ctx: z.RefinementCtx,
): void {
	for (const field of NEEDS[settings.provider]) {
		if (settings[field] === undefined) {
			ctx.addIssue({ code: "custom", path: [field], message: "is required" });
		}
	}
	if (settings.provider === "dex" && settings.clientSecret !== null) {
		ctx.addIssue({
			code: "custom",
			path: ["clientSecret"],
			message: "Dex passwords need no client secret",
		});
	}
}

/**
 * The body of `POST /admin/signin`. `clientSecret` null keeps the stored
 * secret, except that the job clears it when the issuer, tenant or client
 * ID changes (ADR 0059).
 */
export const SigninSettings = z.object(SigninFields).strict().superRefine(checkSignin);
export type SigninSettings = z.infer<typeof SigninSettings>;

// ---- The root site job: request files ----

export const SiteJobId = z.string().uuid();

export const SiteJobKind = z.enum([
	"proxy-hosts",
	"lti-platforms",
	"address",
	"signin",
	"keep",
	"rollback",
]);
export type SiteJobKind = z.infer<typeof SiteJobKind>;

/** The trial a keep or rollback ends: the id of its address or signin job. */
export const TrialRef = z.object({ trialId: SiteJobId }).strict();
export type TrialRef = z.infer<typeof TrialRef>;

const RequestHead = {
	version: z.literal(1),
	id: SiteJobId,
	requestedAt: z.string().datetime(),
};

/**
 * What the API writes as `request-<id>.json` in SITE_JOBS_DIR, mode 0600.
 * A signin request may hold the client secret, so the API never reads one
 * back.
 */
export const SiteJobRequest = z.discriminatedUnion("kind", [
	z
		.object({
			...RequestHead,
			kind: z.literal("proxy-hosts"),
			...ProxyHostsUpdate.shape,
		})
		.strict(),
	z
		.object({
			...RequestHead,
			kind: z.literal("lti-platforms"),
			...LtiPlatformsUpdate.shape,
		})
		.strict(),
	z
		.object({ ...RequestHead, kind: z.literal("address"), ...AddressSettings.shape })
		.strict(),
	z
		.object({ ...RequestHead, kind: z.literal("signin"), ...SigninFields })
		.strict()
		.superRefine(checkSignin),
	z.object({ ...RequestHead, kind: z.literal("keep"), ...TrialRef.shape }).strict(),
	z.object({ ...RequestHead, kind: z.literal("rollback"), ...TrialRef.shape }).strict(),
]);
export type SiteJobRequest = z.infer<typeof SiteJobRequest>;

/** A request without the head the API adds when it writes the file. */
export type SiteJobBody = SiteJobRequest extends infer R
	? R extends unknown
		? Omit<R, "version" | "id" | "requestedAt">
		: never
	: never;

// ---- The root site job: status files ----

/** The job's fixed codes; never a program's own text. */
export const SiteJobCode = z.enum([
	"invalid_request",
	"invalid_value",
	"too_many",
	"duplicate",
	"operator_platform",
	"mock_platform",
	"reserved_port",
	"certificate_not_covering",
	"not_apt_install",
	"missing_secret",
	"trial_open",
	"busy",
	"no_open_trial",
	"proxy_config_rejected",
	"proxy_reload_failed",
	"api_restart_failed",
	"setup_failed",
	"trial_expired",
	"rolled_back",
	"write_failed",
]);
export type SiteJobCode = z.infer<typeof SiteJobCode>;

/**
 * `trial` is an address or signin change waiting for Keep; `kept` and
 * `reverted` end it. Every other kind ends `done` or `failed`.
 */
export const SiteJobState = z.enum([
	"queued",
	"running",
	"trial",
	"kept",
	"reverted",
	"done",
	"failed",
]);
export type SiteJobState = z.infer<typeof SiteJobState>;

export const SITE_JOB_FINISHED_STATES: readonly SiteJobState[] = [
	"kept",
	"reverted",
	"done",
	"failed",
];

/**
 * `status/<id>.json` in SITE_JOBS_DIR, written by the job; `status/<id>.log`
 * beside it holds setup's output. Neither ever holds a secret.
 */
export const SiteJobStatusFile = z
	.object({
		id: SiteJobId,
		kind: SiteJobKind,
		state: SiteJobState.exclude(["queued"]),
		code: SiteJobCode.nullable(),
		startedAt: z.string().nullable(),
		finishedAt: z.string().nullable(),
		/** Set while a trial is open: when the job puts the old settings back. */
		trialEndsAt: z.string().nullable().optional(),
	})
	.strict();
export type SiteJobStatusFile = z.infer<typeof SiteJobStatusFile>;

/** A job as the page sees it. A queued job's kind is unknown: its request is not read back. */
export const SiteJobView = z
	.object({
		id: SiteJobId,
		kind: SiteJobKind.nullable(),
		state: SiteJobState,
		code: SiteJobCode.nullable(),
		requestedAt: z.string().nullable(),
		startedAt: z.string().nullable(),
		finishedAt: z.string().nullable(),
		trialEndsAt: z.string().nullable(),
	})
	.strict();
export type SiteJobView = z.infer<typeof SiteJobView>;

/**
 * A job queued or running longer than this has died: setup can take many
 * minutes, plus a margin. It no longer blocks a new request.
 */
export const SITE_JOB_STALE_MS = 45 * 60_000;

/** A job with the tail of its setup output, as the address and sign-in pages show it. */
export const SiteJobDetail = z
	.object({ job: SiteJobView, log: z.array(z.string()) })
	.strict();
export type SiteJobDetail = z.infer<typeof SiteJobDetail>;

// ---- The view file ----

const SiteCertificateSource = z.enum([
	"internal",
	"acme",
	"files",
] as const satisfies readonly CertificateSource[]);

/**
 * `/etc/portikus/site-view.json` (0644), written by setup: the settings the
 * page shows. Strict, so a secret can never be read through it; the client
 * secret appears only as `clientSecretSet`.
 */
export const SiteView = z
	.object({
		version: z.literal(1),
		/** True on an apt install, where address and sign-in changes work. */
		apt: z.boolean(),
		host: z.string(),
		port: z.number().int(),
		previewSuffix: z.string(),
		/** Set in portikus.yaml by hand, so an address change keeps it. */
		previewSuffixSetByHand: z.boolean(),
		provider: z.enum(["dex", "entra", "google", "oidc", "ldap"]),
		entraTenantId: z.string().nullable(),
		googleDomains: z.array(z.string()),
		oidcIssuer: z.string().nullable(),
		clientId: z.string().nullable(),
		clientSecretSet: z.boolean(),
		groupsClaim: z.string().nullable(),
		groups: z
			.object({ student: z.string(), instructor: z.string(), admin: z.string() })
			.strict(),
		ldapHost: z.string().optional(),
		certificateSource: SiteCertificateSource,
	})
	.strict();
export type SiteView = z.infer<typeof SiteView>;

// ---- Admin page bodies ----

/** `GET /admin/proxy-hosts`. */
export const AdminProxyHosts = z
	.object({
		/** The operator's list from Ansible, read-only on the page. */
		operatorHosts: z.array(z.string()),
		hosts: z.array(z.string()),
		/** The waiting or running job, else the newest; null before the first save. */
		job: SiteJobView.nullable(),
	})
	.strict();
export type AdminProxyHosts = z.infer<typeof AdminProxyHosts>;

/** The tool's own LTI addresses, which an administrator enters in the LMS to register Portikus. */
export const LtiToolUrls = z
	.object({
		loginUrl: z.string(),
		launchUrl: z.string(),
		keysetUrl: z.string(),
		/** Portikus answers Deep Linking requests at its launch address. */
		deepLinkingUrl: z.string(),
	})
	.strict();
export type LtiToolUrls = z.infer<typeof LtiToolUrls>;

/** `GET /admin/lms`. */
export const AdminLmsPlatforms = z
	.object({
		toolUrls: LtiToolUrls,
		/** The operator's platforms file, read-only on the page. */
		operatorPlatforms: z.array(OperatorLtiPlatform),
		platforms: z.array(AdminLtiPlatform),
		job: SiteJobView.nullable(),
	})
	.strict();
export type AdminLmsPlatforms = z.infer<typeof AdminLmsPlatforms>;

/** `GET /admin/address`. `current` is null off apt installs or before setup wrote the view. */
export const AdminAddress = z
	.object({
		current: SiteView.pick({
			host: true,
			port: true,
			previewSuffix: true,
			previewSuffixSetByHand: true,
			certificateSource: true,
		}).nullable(),
		/** True on an apt install, where the address can be changed here. */
		apt: z.boolean(),
		/** The address the shown job asked for, from its audit row; null with no job. */
		target: AddressSettings.nullable(),
		job: SiteJobView.nullable(),
	})
	.strict();
export type AdminAddress = z.infer<typeof AdminAddress>;

/** `POST /admin/address/plan`: what moving to the new address changes. */
export const AddressPlan = z
	.object({
		siteUrl: z.string(),
		dexIssuer: z.string(),
		dexCallbackUrl: z.string(),
		lti: z
			.object({ loginUrl: z.string(), launchUrl: z.string(), keysetUrl: z.string() })
			.strict(),
		previewSuffix: z.string(),
		previewSuffixSetByHand: z.boolean(),
		previewWildcard: z.string(),
		certificate: z
			.object({
				source: SiteCertificateSource,
				/** False for uploaded files that do not cover the new names. */
				allowed: z.boolean(),
			})
			.strict(),
		/** Running workspaces that keep the old preview suffix until their next start. */
		workspacesKeepingOldSuffix: z.array(
			z.object({ id: z.string(), label: z.string(), ownerName: z.string() }).strict(),
		),
		/** The DNS names that must point at this server before the switch. */
		dnsNames: z.array(z.string()),
		/** What happens to the certificate, in one or two sentences. */
		certificateNote: z.string(),
		/** The steps outside Portikus, in order, as plain sentences. */
		checklist: z.array(z.string()),
	})
	.strict();
export type AddressPlan = z.infer<typeof AddressPlan>;

// The address pre-flight answers CertificatePreflight (certificate.ts).

/** The sign-in settings the page shows: the view file's sign-in part. */
export const SigninView = SiteView.pick({
	provider: true,
	entraTenantId: true,
	googleDomains: true,
	oidcIssuer: true,
	clientId: true,
	clientSecretSet: true,
	groupsClaim: true,
	groups: true,
	ldapHost: true,
});
export type SigninView = z.infer<typeof SigninView>;

/** The newest `settings.signin_tested` audit row, never an email. */
export const SigninTestResult = z
	.object({
		/** The trial the test ran against; Keep needs a passing test of the open trial. */
		trialId: SiteJobId.nullable(),
		result: z.enum(["passed", "failed"]),
		role: Role.nullable(),
		connector: z.string().nullable(),
		at: z.string(),
	})
	.strict();
export type SigninTestResult = z.infer<typeof SigninTestResult>;

/** `GET /admin/signin`. `current` is null off apt installs or before setup wrote the view. */
export const AdminSignin = z
	.object({
		current: SigninView.nullable(),
		job: SiteJobView.nullable(),
		lastTest: SigninTestResult.nullable(),
	})
	.strict();
export type AdminSignin = z.infer<typeof AdminSignin>;
