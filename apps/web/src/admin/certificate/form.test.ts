import {
	ACME_DIRECTORY_PRESETS,
	CertificateJobRequest,
	type CertificateSettingsView,
	DNS_PROVIDER_FIELDS,
} from "@portikus/contracts";
import { expect, test } from "vitest";
import {
	type CertificateForm,
	daysText,
	directoryChoice,
	expiry,
	FIELD_ID,
	fieldLabel,
	initialForm,
	PROVIDER_LABEL,
	PROVIDERS,
	pemProblem,
	secretProblem,
	settingsText,
	testIsReal,
	toSettings,
	uploadRefusalField,
	uploadRefusalText,
	validate,
	withPlain,
	withSecret,
} from "./form.js";

// The contract accepts only a whole service-account key (SPEC.md 24.8).
const FAKE_KEY = {
	type: "service_account",
	project_id: "fake",
	private_key_id: "fake-id",
	private_key: "fake-key",
	client_email: "fake@fake.iam.gserviceaccount.com",
};

const PEM = "-----BEGIN CERTIFICATE-----\nMIIfake\n-----END CERTIFICATE-----\n";
// A fake key, split so the secret scanner does not mistake it for a real one.
const KEY = `-----BEGIN ${"PRIVATE"} KEY-----\nMIIfake\n-----END ${"PRIVATE"} KEY-----\n`;
const CHAIN = "-----BEGIN CERTIFICATE-----\nMIIchain\n-----END CERTIFICATE-----\n";

const ACME_VIEW: CertificateSettingsView = {
	source: "acme",
	directory: ACME_DIRECTORY_PRESETS.letsencrypt,
	email: "it@example.edu",
	eab: null,
	challenge: {
		mode: "dns01",
		provider: "route53",
		fields: { region: "us-east-1", access_key_id: "AKIAFAKE" },
		secretsSet: { secret_access_key: true },
	},
};

function acme(over: Partial<CertificateForm> = {}): CertificateForm {
	return {
		...initialForm(null),
		source: "acme",
		email: "it@example.edu",
		...over,
	};
}

test("the form starts from the settings in force, with every secret blank (Epic 27 R8)", () => {
	const form = initialForm(ACME_VIEW);
	expect(form.source).toBe("acme");
	expect(form.directory).toBe("letsencrypt");
	expect(form.provider).toBe("route53");
	expect(form.plain).toEqual({
		"route53.region": "us-east-1",
		"route53.access_key_id": "AKIAFAKE",
	});
	expect(form.secrets).toEqual({});
	expect(form.eabHmacKey).toBe("");
	expect(initialForm(null).source).toBe("internal");
});

test("a directory that is no preset is a custom one", () => {
	expect(directoryChoice(ACME_DIRECTORY_PRESETS.zerossl)).toBe("zerossl");
	expect(directoryChoice("https://acme.example.edu/dir")).toBe("custom");
	const form = initialForm({ ...ACME_VIEW, directory: "https://acme.example.edu/dir" });
	expect(form.directory).toBe("custom");
	expect(form.customDirectory).toBe("https://acme.example.edu/dir");
});

test("a blank secret keeps the stored one and is left out of the request", () => {
	const form = initialForm(ACME_VIEW);
	expect(validate(form, ACME_VIEW)).toEqual({});
	const settings = toSettings(form);
	expect(settings).toEqual({
		source: "acme",
		directory: ACME_DIRECTORY_PRESETS.letsencrypt,
		email: "it@example.edu",
		challenge: {
			mode: "dns01",
			dns: {
				provider: "route53",
				fields: { region: "us-east-1", access_key_id: "AKIAFAKE" },
			},
		},
	});
	expect(CertificateJobRequest.safeParse({ kind: "apply", settings }).success).toBe(
		true,
	);
});

test("a secret not stored for the chosen provider must be entered", () => {
	const form = acme({ provider: "cloudflare" });
	expect(validate(form, ACME_VIEW)).toEqual({
		[FIELD_ID.provider("api_token")]: "Enter the API token.",
	});
	const filled = withSecret(form, "api_token", "fake-token-for-tests");
	expect(validate(filled, ACME_VIEW)).toEqual({});
	expect(
		CertificateJobRequest.parse({ kind: "test", settings: toSettings(filled) }),
	).toEqual({
		kind: "test",
		settings: {
			source: "acme",
			directory: ACME_DIRECTORY_PRESETS.letsencrypt,
			email: "it@example.edu",
			challenge: {
				mode: "dns01",
				dns: { provider: "cloudflare", fields: { api_token: "fake-token-for-tests" } },
			},
		},
	});
});

test("one provider's values never leak into another's", () => {
	let form = acme({ provider: "porkbun" });
	form = withPlain(form, "api_key", "pk1_fake");
	form = withSecret(form, "api_secret_key", "sk1_fake");
	form = { ...form, provider: "hetzner" };
	form = withSecret(form, "api_token", "fake-hetzner");
	const settings = toSettings(form);
	expect(settings.source === "acme" && settings.challenge).toEqual({
		mode: "dns01",
		dns: { provider: "hetzner", fields: { api_token: "fake-hetzner" } },
	});
});

test("every provider in the contract builds a request the contract accepts", () => {
	for (const provider of PROVIDERS) {
		let form = acme({ provider });
		const fields = DNS_PROVIDER_FIELDS[provider];
		for (const name of fields.plain) form = withPlain(form, name, "fake-value");
		for (const name of fields.secret) {
			const value =
				name === "service_account_json" ? JSON.stringify(FAKE_KEY) : "fake-secret";
			form = withSecret(form, name, value);
		}
		expect(validate(form, null)).toEqual({});
		const parsed = CertificateJobRequest.safeParse({
			kind: "apply",
			settings: toSettings(form),
		});
		expect(parsed.success, provider).toBe(true);
		expect(PROVIDER_LABEL[provider]).toBeTruthy();
		for (const name of [...fields.plain, ...fields.secret]) {
			expect(fieldLabel(name)).not.toContain("_");
		}
	}
});

test("plain fields are required and refuse characters that could break the Caddyfile", () => {
	const form = withPlain(acme({ provider: "route53" }), "region", "us east");
	const errors = validate(withSecret(form, "secret_access_key", "x"), null);
	expect(errors[FIELD_ID.provider("region")]).toMatch(/no spaces/);
	expect(errors[FIELD_ID.provider("access_key_id")]).toBe("Enter the Access key ID.");
});

test("email and a custom directory are checked", () => {
	const errors = validate(
		acme({
			email: "",
			directory: "custom",
			customDirectory: "http://acme.example.edu",
		}),
		null,
	);
	expect(errors[FIELD_ID.email]).toBe("Enter the account email.");
	expect(errors[FIELD_ID.customDirectory]).toBe(
		"The directory URL must start with https://.",
	);
	expect(validate(acme({ email: "not-an-email", mode: "http01" }), null)).toEqual({
		[FIELD_ID.email]: "Enter an email address, such as it@example.edu.",
	});
});

test("external account binding: a key ID needs an HMAC key unless one is stored", () => {
	const form = acme({ mode: "http01", eabKeyId: "kid_1" });
	expect(validate(form, null)).toEqual({
		[FIELD_ID.eabHmacKey]: "Enter the HMAC key.",
	});
	const stored: CertificateSettingsView = {
		...ACME_VIEW,
		eab: { keyId: "kid_1", hmacKeySet: true },
	};
	expect(validate(form, stored)).toEqual({});
	expect(toSettings(form)).toMatchObject({ eab: { keyId: "kid_1" } });
	expect(toSettings({ ...form, eabHmacKey: "aGVsbG8_fake" })).toMatchObject({
		eab: { keyId: "kid_1", hmacKey: "aGVsbG8_fake" },
	});
	expect(
		validate(acme({ mode: "http01", eabHmacKey: "aGVsbG8" }), null)[FIELD_ID.eabKeyId],
	).toBe("Enter the key ID that goes with the HMAC key.");
	expect(toSettings(acme({ mode: "http01" }))).not.toHaveProperty("eab");
});

test("HTTP-01 sends no DNS fields", () => {
	expect(toSettings(acme({ mode: "http01" }))).toEqual({
		source: "acme",
		directory: ACME_DIRECTORY_PRESETS.letsencrypt,
		email: "it@example.edu",
		challenge: { mode: "http01" },
	});
});

test("an upload needs a certificate and a key, and joins the chain after the certificate", () => {
	const empty = { ...initialForm(null), source: "files" as const };
	expect(validate(empty, null)).toEqual({
		[FIELD_ID.upload("site", "certificate")]: "Choose the certificate file.",
		[FIELD_ID.upload("site", "privateKey")]: "Choose the private key file.",
	});
	const form: CertificateForm = {
		...empty,
		site: { certificate: PEM, chain: CHAIN, privateKey: KEY },
	};
	expect(validate(form, null)).toEqual({});
	const settings = toSettings(form);
	expect(settings).toEqual({
		source: "files",
		site: { certificate: `${PEM.trim()}\n${CHAIN.trim()}\n`, privateKey: KEY },
	});
	expect(CertificateJobRequest.safeParse({ kind: "apply", settings }).success).toBe(
		true,
	);
});

test("a stored key may be kept, and a separate preview certificate is checked too", () => {
	const stored: CertificateSettingsView = {
		source: "files",
		site: {
			certificate: {
				issuer: "CN=Campus CA",
				names: ["portikus.example.edu"],
				notBefore: "2026-01-01T00:00:00.000Z",
				notAfter: "2027-01-01T00:00:00.000Z",
			},
			privateKeySet: true,
		},
		preview: null,
	};
	const form: CertificateForm = {
		...initialForm(stored),
		site: { certificate: PEM, chain: "", privateKey: "" },
		separatePreview: true,
	};
	expect(validate(form, stored)).toEqual({
		[FIELD_ID.upload("preview", "certificate")]: "Choose the certificate file.",
		[FIELD_ID.upload("preview", "privateKey")]: "Choose the private key file.",
	});
	const both = { ...form, preview: { certificate: PEM, chain: "", privateKey: KEY } };
	expect(toSettings(both)).toEqual({
		source: "files",
		site: { certificate: PEM },
		preview: { certificate: PEM, privateKey: KEY },
	});
});

test("a file that is not PEM is named as such", () => {
	expect(pemProblem("")).toBeNull();
	expect(pemProblem(PEM)).toBeNull();
	expect(pemProblem("binary DER")).toMatch(/not in PEM format/);
	expect(pemProblem(`-----BEGIN ${"x".repeat(70_000)}`)).toMatch(/larger than 64 KB/);
});

test("only ZeroSSL and custom directories get a real certificate from Test only (R11 amendment)", () => {
	expect(testIsReal(acme({ directory: "letsencrypt" }))).toBe(false);
	expect(testIsReal(acme({ directory: "letsencrypt-staging" }))).toBe(false);
	expect(testIsReal(acme({ directory: "zerossl" }))).toBe(true);
	expect(testIsReal(acme({ directory: "custom" }))).toBe(true);
});

test("the settings in force read as one line", () => {
	expect(settingsText({ source: "internal" })).toBe("Internal authority");
	expect(settingsText(ACME_VIEW)).toBe(
		"ACME with Let's Encrypt, DNS-01 through Amazon Route 53",
	);
	expect(
		settingsText({
			...ACME_VIEW,
			directory: "https://acme.example.edu/dir",
			challenge: { mode: "http01" },
		}),
	).toBe("ACME with https://acme.example.edu/dir, HTTP-01");
});

test("expiry is soon inside the 14-day warning and expired once past", () => {
	const now = new Date("2026-09-30T12:00:00Z");
	expect(expiry("2026-12-29T12:00:00Z", now, 14)).toEqual({ days: 90, tone: "ok" });
	expect(expiry("2026-10-14T12:00:01Z", now, 14).tone).toBe("ok");
	expect(expiry("2026-10-14T11:59:59Z", now, 14)).toEqual({ days: 13, tone: "soon" });
	expect(expiry("2026-09-29T12:00:00Z", now, 14)).toEqual({
		days: -1,
		tone: "expired",
	});
	expect(daysText(90)).toBe("in 90 days");
	expect(daysText(1)).toBe("in 1 day");
	expect(daysText(0)).toBe("in less than a day");
	expect(daysText(-1)).toBe("1 day ago");
	expect(daysText(-3)).toBe("3 days ago");
});

test("secrets are one line, except Google's service account key, which is a JSON object", () => {
	expect(secretProblem("api_token", "", true)).toBeNull();
	expect(secretProblem("api_token", "", false)).toBe("Enter the API token.");
	expect(secretProblem("api_token", "fake\ntoken", false)).toBe(
		"Enter it on one line.",
	);
	expect(secretProblem("api_token", "x".repeat(1025), false)).toMatch(/1,024/);
	expect(
		secretProblem("service_account_json", JSON.stringify(FAKE_KEY), false),
	).toBeNull();
	expect(secretProblem("service_account_json", "[1]", false)).toMatch(/whole JSON key/);
	expect(secretProblem("service_account_json", "{not json", false)).toMatch(
		/whole JSON key/,
	);
	const multiline = JSON.stringify(FAKE_KEY, null, 2);
	const form = withSecret(
		withPlain(acme({ provider: "googleclouddns" }), "gcp_project", "fake-project"),
		"service_account_json",
		multiline,
	);
	expect(validate(form, null)).toEqual({});
	expect(
		CertificateJobRequest.safeParse({ kind: "apply", settings: toSettings(form) })
			.success,
	).toBe(true);
});

test("a refused upload names its check in words (Epic 27 R9)", () => {
	expect(
		uploadRefusalText(
			"Preview certificate: the names-cover check failed. The certificate does not cover *.preview.example.edu.",
		),
	).toBe(
		'Preview certificate: failed the check "Names cover the site". The certificate does not cover *.preview.example.edu.',
	);
	expect(uploadRefusalText("Something else went wrong.")).toBe(
		"Something else went wrong.",
	);
	expect(uploadRefusalText("Site certificate: the unknown-thing check failed. x")).toBe(
		"Site certificate: the unknown-thing check failed. x",
	);
});

test("a refused upload points at the file its check reads (SPEC.md section 25.8)", () => {
	expect(uploadRefusalField("Site certificate: the key-matches check failed. x")).toBe(
		"cert-site-key",
	);
	expect(
		uploadRefusalField("Preview certificate: the chain-complete check failed. x"),
	).toBe("cert-preview-chain");
	expect(uploadRefusalField("Site certificate: the names-cover check failed. x")).toBe(
		"cert-site-certificate",
	);
	expect(
		uploadRefusalField("Site certificate: the unknown-thing check failed. x"),
	).toBeNull();
	expect(uploadRefusalField("Something else went wrong.")).toBeNull();
});
