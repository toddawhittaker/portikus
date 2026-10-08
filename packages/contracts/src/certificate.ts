import { z } from "zod";

/**
 * The site certificate page and its root job (docs/SPEC.md sections 20.1
 * and 24.10; ADR 0046). This comment is the contract the root job
 * (`packaging/certificate/certificate-job`) implements; the API side only
 * reads what the job writes, and writes nothing but one request file.
 * Caddy stays the only ACME client: the job writes Caddy's configuration
 * and Caddy requests and renews.
 *
 * Three places on the host:
 *
 * - The job directory (env `CERTIFICATE_JOBS_DIR`)
 *   (`/var/lib/portikus/certificate-jobs/`, root:portikus, 0770).
 *   - The API writes one request as `request-<id>.json`, where `<id>` is a
 *     lowercase UUID, with mode 0600. It writes `.request-<id>.tmp` first
 *     and renames it, so the path unit
 *     (`PathExistsGlob=.../request-*.json`) never sees a half-written
 *     file. The body is `CertificateJobRequestFile` below and may carry
 *     secrets (a DNS token, an EAB HMAC key, an uploaded private key).
 *   - The job reads the request, keeps any secret only in the state
 *     directory, writes `<id>/request.json` as `CertificateJobRecord` (the
 *     same request with every secret replaced by a "set" flag) and deletes
 *     `request-<id>.json`. No secret stays in the job directory.
 *   - The job writes `<id>/status.json` (`CertificateJobStatusFile`) and
 *     `<id>/log.txt`, both group-readable by `portikus`, rewriting
 *     status.json (temporary file, then rename) at each step. Neither
 *     holds a secret; the job scrubs every stored secret value out of
 *     Caddy's messages before writing them.
 *   - A request that fails validation still gets a `<id>/` with state
 *     `refused` and a message naming the failed check, when `<id>` is
 *     itself a UUID; otherwise it is only logged to the journal (without
 *     its body) and deleted.
 *   - Only one job runs at a time. The API also refuses a new request while
 *     a `request-*.json` waits or any status says `running`.
 *
 * - The state directory, `/etc/portikus/certificate/` (root:caddy, 0750).
 *   The API never reads or writes here. Setup seeds it only when it does
 *   not exist (first install); after that only the job and
 *   `portikus reset-certificate` change it.
 *   - `settings.json` (`CertificateSettingsView`, 0640): what is in force,
 *     without secrets.
 *   - `secrets/` (root:caddy, 0750): one file per secret (the DNS
 *     provider's secret fields, the EAB HMAC key, Google's service account
 *     JSON), each root:caddy 0640, referenced from the snippet as
 *     `{file./etc/portikus/certificate/secrets/<name>}` placeholders, so
 *     they never reach Caddy's autosave and need no restart. Google Cloud
 *     DNS names its file by path (`gcp_application_default`).
 *   - `files/` (0750): uploaded certificates and keys (keys 0640
 *     root:caddy).
 *   - `tls.caddy` (0640): the snippet the Caddyfile imports for both site
 *     blocks (and, for HTTP-01, the preview block's on-demand directive).
 *   - `previous/`: one earlier generation of all of the above, for
 *     `rollback` and for `reset-certificate`.
 *
 * - The status directory, `/var/lib/portikus/certificate/` (root, 0755).
 *   The API only reads here, and finds it beside the job directory.
 *   - `status.json` (`CertificateStatusFile`, 0644), rewritten by the
 *     hourly `check` (portikus-certificate-check.timer) and after each job.
 *     It also carries a copy of `settings.json` and whether `previous/`
 *     exists, because the API cannot read the state directory.
 *   - `root.crt` (0644): a copy of Caddy's internal root certificate, for
 *     the admin download.
 *
 * Every file is written to a temporary name in the same directory and
 * renamed into place. The job keeps the last 20 job directories and
 * deletes older ones.
 *
 * The job never switches the live issuer and waits: a reload to an issuer
 * with no stored certificate leaves every name unserved until issuance
 * ends. Instead a throwaway Caddy (admin off, its own storage seeded with
 * a copy of the live ACME account, one site block on a loopback spare
 * port importing the candidate snippet) issues, and the job kills it at a
 * deadline, because Caddy retries forever and never exits on its own.
 * Every reload of the live Caddy uses `--force`.
 *
 * The job's kinds and their steps (each step is `status.json`'s `step`):
 * - `test`: pre-flight, then a test issuance by the throwaway Caddy (Let's
 *   Encrypt staging when the directory is Let's Encrypt production,
 *   otherwise the chosen directory itself). Nothing live changes.
 * - `apply` (ACME): pre-flight, test issuance, production issuance by the
 *   throwaway Caddy, copy the new certificates into live storage, save
 *   the current generation as `previous`, swap the snippet and reload,
 *   then check the served certificate on loopback (SNI for the site and a
 *   sample preview name). If that check fails the job puts `previous`
 *   back and reloads (`restored` true). If the throwaway fails, nothing
 *   live was touched. `apply` for `internal` or `files` skips the
 *   issuance steps.
 * - `renew`: the throwaway Caddy gets a new certificate, the job copies it
 *   into live storage and reloads to the internal issuer and back. It
 *   never deletes the live certificate first.
 * - `rollback` swaps the current and previous generations and reloads;
 *   `check` refreshes status.json only.
 * - `reset` is never requested by the API: `portikus reset-certificate`
 *   writes it as a job directory of its own (status only, no request file)
 *   so the API can audit it.
 */

/** Longest PEM text the API accepts in one upload field. */
export const MAX_PEM_LENGTH = 64 * 1024;

/** Directories the page offers by name; any other https directory is allowed too. */
export const ACME_DIRECTORY_PRESETS = {
	letsencrypt: "https://acme-v02.api.letsencrypt.org/directory",
	"letsencrypt-staging": "https://acme-staging-v02.api.letsencrypt.org/directory",
	zerossl: "https://acme.zerossl.com/v2/DV90",
} as const;
export type AcmeDirectoryPreset = keyof typeof ACME_DIRECTORY_PRESETS;

/**
 * The nine caddy-dns plugins Caddy is built with, each with
 * the plugin's own Caddyfile field names, split into plain fields (shown on
 * the page) and secret fields (write-only); every field is required.
 * One exception:
 * Google's `service_account_json` is the JSON text itself; the job writes
 * it to a file and gives the plugin that path as `gcp_application_default`.
 * Hetzner is the v2 plugin (the Hetzner Cloud DNS API).
 * `packages/contracts/fixtures/dns-provider-fields.json` mirrors this
 * table for the root job's Python tests; a test keeps the two equal.
 */
export const DNS_PROVIDER_FIELDS = {
	cloudflare: { plain: [], secret: ["api_token"] },
	route53: { plain: ["region", "access_key_id"], secret: ["secret_access_key"] },
	digitalocean: { plain: [], secret: ["api_token"] },
	ovh: {
		plain: ["endpoint", "application_key"],
		secret: ["application_secret", "consumer_key"],
	},
	hetzner: { plain: [], secret: ["api_token"] },
	gandi: { plain: [], secret: ["bearer_token"] },
	porkbun: { plain: ["api_key"], secret: ["api_secret_key"] },
	googleclouddns: { plain: ["gcp_project"], secret: ["service_account_json"] },
	azure: {
		plain: ["tenant_id", "client_id", "subscription_id", "resource_group_name"],
		secret: ["client_secret"],
	},
} as const satisfies Record<
	string,
	{ plain: readonly string[]; secret: readonly string[] }
>;

export const DnsProvider = z.enum([
	"cloudflare",
	"route53",
	"digitalocean",
	"ovh",
	"hetzner",
	"gandi",
	"porkbun",
	"googleclouddns",
	"azure",
]);
export type DnsProvider = z.infer<typeof DnsProvider>;

/** A plain field: one line, no characters that could break out of the Caddyfile. */
const PlainValue = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9._:/@-]+$/);

/** A secret token: kept whole, one line. Omitted means keep the stored one. */
const SecretValue = z
	.string()
	.min(1)
	.max(1024)
	.regex(/^[^\r\n]+$/, "must be one line");

export const MAX_SERVICE_ACCOUNT_JSON = 16 * 1024;

/** Google's service account key: JSON text holding one object. */
const ServiceAccountJson = z
	.string()
	.min(1)
	.max(MAX_SERVICE_ACCOUNT_JSON)
	.refine(isServiceAccountKey, "must be a Google service-account key file");

/**
 * Whether a flat JSON object of string values names a key twice. In such an
 * object the string tokens alternate key, value, so the keys are every
 * other token.
 */
function hasDuplicateKey(text: string): boolean {
	const tokens = text.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
	const keys = tokens
		.filter((_, index) => index % 2 === 0)
		.map((token) => JSON.parse(token) as string);
	return new Set(keys).size !== keys.length;
}

/**
 * A Google service-account key, and nothing Google's library would treat as
 * an instruction to read a local file or fetch a URL as caddy (SPEC.md 24.8).
 */
export function isServiceAccountKey(text: string): boolean {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return false;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const key = value as Record<string, unknown>;
	const names = Object.keys(key);
	// The same check as the root job's _service_account, so the form and the job agree.
	if (!SERVICE_ACCOUNT_REQUIRED.every((name) => names.includes(name))) return false;
	if (!names.every((name) => SERVICE_ACCOUNT_KEYS.includes(name))) return false;
	if (!Object.values(key).every((v) => typeof v === "string")) return false;
	if (!SERVICE_ACCOUNT_REQUIRED.every((name) => key[name] !== "")) return false;
	if (key.type !== "service_account") return false;
	// JSON.parse keeps the last of a repeated key; the root job refuses it.
	if (hasDuplicateKey(text)) return false;
	// Google's library posts a signed assertion to token_uri, so only Google's own.
	if ((key.token_uri ?? GOOGLE_TOKEN_URI) !== GOOGLE_TOKEN_URI) return false;
	return (key.universe_domain ?? GOOGLE_UNIVERSE) === GOOGLE_UNIVERSE;
}

const SERVICE_ACCOUNT_REQUIRED = [
	"type",
	"project_id",
	"private_key_id",
	"private_key",
	"client_email",
];
const SERVICE_ACCOUNT_KEYS = [
	...SERVICE_ACCOUNT_REQUIRED,
	"client_id",
	"auth_uri",
	"token_uri",
	"auth_provider_x509_cert_url",
	"client_x509_cert_url",
	"universe_domain",
];
const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
const GOOGLE_UNIVERSE = "googleapis.com";

function providerSchema<P extends DnsProvider>(provider: P) {
	const fields = DNS_PROVIDER_FIELDS[provider];
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const name of fields.plain) shape[name] = PlainValue;
	for (const name of fields.secret) {
		shape[name] = (
			name === "service_account_json" ? ServiceAccountJson : SecretValue
		).optional();
	}
	return z
		.object({ provider: z.literal(provider), fields: z.object(shape).strict() })
		.strict();
}

export const DnsChallenge = z.discriminatedUnion("provider", [
	providerSchema("cloudflare"),
	providerSchema("route53"),
	providerSchema("digitalocean"),
	providerSchema("ovh"),
	providerSchema("hetzner"),
	providerSchema("gandi"),
	providerSchema("porkbun"),
	providerSchema("googleclouddns"),
	providerSchema("azure"),
]);
export type DnsChallenge = z.infer<typeof DnsChallenge>;

export const AcmeChallenge = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("dns01"), dns: DnsChallenge }).strict(),
	/** HTTP-01 for the site, on-demand TLS for each preview name. */
	z.object({ mode: z.literal("http01") }).strict(),
]);
export type AcmeChallenge = z.infer<typeof AcmeChallenge>;

const HttpsUrl = z
	.string()
	.url()
	.max(500)
	.refine((url) => url.startsWith("https://"), "must be an https URL");

/** External account binding (ZeroSSL, campus authorities). The HMAC key is omitted to keep the stored one. */
export const AcmeEab = z
	.object({
		keyId: z
			.string()
			.min(1)
			.max(200)
			.regex(/^[A-Za-z0-9_-]+$/),
		hmacKey: z
			.string()
			.min(1)
			.max(200)
			.regex(/^[A-Za-z0-9_=-]+$/)
			.optional(),
	})
	.strict();

const Pem = z
	.string()
	.min(1)
	.max(MAX_PEM_LENGTH)
	.refine((pem) => pem.includes("-----BEGIN "), "must be PEM text");

/** An uploaded certificate (leaf first, then the chain) and its key. The key is omitted to keep the stored one. */
export const UploadedCertificate = z
	.object({ certificate: Pem, privateKey: Pem.optional() })
	.strict();

export const AcmeSettings = z
	.object({
		source: z.literal("acme"),
		directory: HttpsUrl,
		email: z.string().email().max(200),
		eab: AcmeEab.optional(),
		challenge: AcmeChallenge,
	})
	.strict();

export const CertificateSettings = z.discriminatedUnion("source", [
	z.object({ source: z.literal("internal") }).strict(),
	AcmeSettings,
	z
		.object({
			source: z.literal("files"),
			site: UploadedCertificate,
			/** A separate wildcard for previews; without it the site certificate must cover them. */
			preview: UploadedCertificate.optional(),
		})
		.strict(),
]);
export type CertificateSettings = z.infer<typeof CertificateSettings>;
export type CertificateSource = CertificateSettings["source"];

/**
 * Job kinds. HTTP-01 tests and applies run in a throwaway Caddy listening on
 * 127.0.0.1:8796; the live port-80 site block proxies
 * /.well-known/acme-challenge/* there.
 */
export const CertificateJobKind = z.enum([
	"test",
	"apply",
	"renew",
	"rollback",
	"check",
	"reset",
]);
export type CertificateJobKind = z.infer<typeof CertificateJobKind>;

/** The body of `POST /admin/certificate/jobs`. `test` takes ACME settings only. */
export const CertificateJobRequest = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("test"),
			settings: AcmeSettings,
		})
		.strict(),
	z.object({ kind: z.literal("apply"), settings: CertificateSettings }).strict(),
	z.object({ kind: z.literal("renew") }).strict(),
	z.object({ kind: z.literal("rollback") }).strict(),
	z.object({ kind: z.literal("check") }).strict(),
]);
export type CertificateJobRequest = z.infer<typeof CertificateJobRequest>;

/**
 * A certificate job waiting or running longer than this has died: the job
 * unit's thirty-minute start timeout plus a margin.
 */
export const CERTIFICATE_JOB_STALE_MS = 35 * 60_000;

export const CertificateJobId = z.string().uuid();

/** `request-<id>.json` as the API writes it (mode 0600). */
export const CertificateJobRequestFile = z
	.object({
		id: CertificateJobId,
		requestedAt: z.string().datetime(),
		/** The administrator's user id, for the job's log. */
		requestedBy: z.string().uuid(),
		request: CertificateJobRequest,
	})
	.strict();
export type CertificateJobRequestFile = z.infer<typeof CertificateJobRequestFile>;

export const CertificateJobState = z.enum([
	"queued",
	"running",
	"succeeded",
	"failed",
	"refused",
]);
export type CertificateJobState = z.infer<typeof CertificateJobState>;

/** `<id>/status.json` as the job writes it. */
export const CertificateJobStatusFile = z
	.object({
		id: CertificateJobId,
		kind: CertificateJobKind.nullable(),
		state: CertificateJobState.exclude(["queued"]),
		/** One short sentence, such as "Testing with the staging directory". */
		step: z.string().max(200),
		/** Why it failed or was refused, secrets scrubbed; null otherwise. */
		message: z.string().max(2000).nullable(),
		/** True when a failed `apply` put the previous settings back. */
		restored: z.boolean(),
		startedAt: z.string().datetime(),
		finishedAt: z.string().datetime().nullable(),
	})
	.strict()
	.refine((file) => file.kind !== null || file.state === "refused", {
		message: "kind may be null only for a refused request",
		path: ["kind"],
	});
export type CertificateJobStatusFile = z.infer<typeof CertificateJobStatusFile>;

/** What one certificate in use says about itself. */
export const CertificateInfo = z
	.object({
		/** The name checked: the site, or a sample preview name. */
		name: z.string().min(1).max(253),
		issuer: z.string().max(500),
		/** Subject alternative names. */
		names: z.array(z.string().max(253)).max(100),
		notBefore: z.string().datetime(),
		notAfter: z.string().datetime(),
	})
	.strict();
export type CertificateInfo = z.infer<typeof CertificateInfo>;

// ---- Views: never a secret, only whether one is set ----

const SecretsSet = z.record(z.string(), z.boolean());

export const UploadedCertificateView = z
	.object({
		certificate: CertificateInfo.omit({ name: true }),
		privateKeySet: z.boolean(),
	})
	.strict();

/** The settings in force, as `settings.json` holds them and the page shows them. */
export const CertificateSettingsView = z.discriminatedUnion("source", [
	z.object({ source: z.literal("internal") }).strict(),
	z
		.object({
			source: z.literal("acme"),
			directory: HttpsUrl,
			email: z.string(),
			eab: z.object({ keyId: z.string(), hmacKeySet: z.boolean() }).strict().nullable(),
			challenge: z.discriminatedUnion("mode", [
				z
					.object({
						mode: z.literal("dns01"),
						provider: DnsProvider,
						/** The plain fields only. */
						fields: z.record(z.string(), z.string()),
						/** Each secret field's name, and whether a value is stored. */
						secretsSet: SecretsSet,
					})
					.strict(),
				z.object({ mode: z.literal("http01") }).strict(),
			]),
		})
		.strict(),
	z
		.object({
			source: z.literal("files"),
			site: UploadedCertificateView,
			preview: UploadedCertificateView.nullable(),
		})
		.strict(),
]);
export type CertificateSettingsView = z.infer<typeof CertificateSettingsView>;

/** `status.json`, rewritten hourly and after each job. */
export const CertificateStatusFile = z
	.object({
		checkedAt: z.string().datetime(),
		source: z.enum(["internal", "acme", "files"]),
		/** A copy of the state directory's settings.json, which the API cannot read. */
		settings: CertificateSettingsView,
		/** Whether the state directory's `previous/` holds a generation to roll back to. */
		previousAvailable: z.boolean(),
		/** Null when the check could not read a certificate. */
		site: CertificateInfo.nullable(),
		/** Null when the check could not read one, or HTTP-01 has issued none yet. */
		preview: CertificateInfo.nullable(),
		/** From Caddy's journal; null when Caddy has not renewed or failed since the last change. */
		lastRenewal: z
			.object({
				ok: z.boolean(),
				at: z.string().datetime(),
				/** The certificate's name from Caddy's journal, when the job could read it. */
				name: z.string().min(1).max(253).optional(),
				/** Caddy's error, secrets scrubbed; null when ok. */
				message: z.string().max(2000).nullable(),
			})
			.strict()
			.nullable(),
		/**
		 * Set while Caddy's internal authority serves a site name that resolves to
		 * a public address, allowed in portikus.yaml or put back by `portikus
		 * reset-certificate` (SPEC.md 24.10). `since` is when the settings in force
		 * last changed. Absent from a file an older job wrote.
		 */
		internalOnPublic: z
			.object({
				since: z.string().datetime(),
				addresses: z.array(z.string().min(2).max(45)).max(4),
			})
			.strict()
			.nullable()
			.optional(),
	})
	.strict();
export type CertificateStatusFile = z.infer<typeof CertificateStatusFile>;

/** The job's own record of what was asked: `<id>/request.json` and the page's view of it. */
export const CertificateJobRecord = z
	.object({
		kind: CertificateJobKind,
		settings: CertificateSettingsView.nullable(),
	})
	.strict();
export type CertificateJobRecord = z.infer<typeof CertificateJobRecord>;

export const CertificateJobView = z
	.object({
		id: CertificateJobId,
		kind: CertificateJobKind.nullable(),
		state: CertificateJobState,
		step: z.string(),
		message: z.string().nullable(),
		restored: z.boolean(),
		requestedAt: z.string().nullable(),
		startedAt: z.string().nullable(),
		finishedAt: z.string().nullable(),
		request: CertificateJobRecord.nullable(),
	})
	.strict();
export type CertificateJobView = z.infer<typeof CertificateJobView>;

/** One pre-flight check. A warning does not block. */
export const PreflightCheck = z
	.object({
		name: z.enum([
			"dns-site",
			"dns-preview",
			"reach-site",
			"reach-preview",
			"http-port-80",
		]),
		result: z.enum(["passed", "warning", "failed"]),
		message: z.string(),
	})
	.strict();
export type PreflightCheck = z.infer<typeof PreflightCheck>;

/** The body of `POST /admin/certificate/preflight`: which challenge the checks are for. */
export const CertificatePreflightRequest = z
	.object({ mode: z.enum(["dns01", "http01"]) })
	.strict();
export type CertificatePreflightRequest = z.infer<typeof CertificatePreflightRequest>;

/** The upload checks the API runs with node:crypto; a refusal names one. */
export const CertificateUploadCheck = z.enum([
	"certificate-readable",
	"key-readable",
	"key-matches",
	"chain-complete",
	"dates-valid",
	"names-cover",
]);
export type CertificateUploadCheck = z.infer<typeof CertificateUploadCheck>;

/** `POST /admin/certificate/preflight`. */
export const CertificatePreflight = z
	.object({
		/** False when any check failed; the API then refuses `test` and `apply`. */
		ok: z.boolean(),
		checks: z.array(PreflightCheck),
	})
	.strict();
export type CertificatePreflight = z.infer<typeof CertificatePreflight>;

/** `GET /admin/certificate`. */
export const AdminCertificate = z
	.object({
		siteName: z.string(),
		previewSuffix: z.string(),
		/** Null when settings.json cannot be read. */
		settings: CertificateSettingsView.nullable(),
		previousAvailable: z.boolean(),
		status: CertificateStatusFile.nullable(),
		/** The queued or running job, else the most recent one. */
		job: CertificateJobView.nullable(),
		/** True when Caddy's internal root can be downloaded. */
		rootCertificateAvailable: z.boolean(),
	})
	.strict();
export type AdminCertificate = z.infer<typeof AdminCertificate>;

/** `GET /admin/certificate/jobs/:id`. */
export const CertificateJobDetail = z
	.object({ job: CertificateJobView, log: z.array(z.string()) })
	.strict();
export type CertificateJobDetail = z.infer<typeof CertificateJobDetail>;

export const CERTIFICATE_LOG_LINES = 500;

/** Days before expiry when administrators are notified. */
export const CERTIFICATE_EXPIRY_WARNING_DAYS = 14;
