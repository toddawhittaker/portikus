/**
 * The certificate job's shapes (docs/SPEC.md sections 20.1 and 24.8).
 * The request reaches a root job, so it must refuse anything loose; the
 * views reach the browser, so they must never hold a secret.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
	AdminCertificate,
	CertificateJobRequest,
	CertificateJobStatusFile,
	CertificateSettingsView,
	CertificateStatusFile,
	DNS_PROVIDER_FIELDS,
	DnsProvider,
} from "./certificate.js";

const ID = "550e8400-e29b-41d4-a716-446655440000";
const NOW = "2026-09-30T12:00:00.000Z";
const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

const acme = {
	source: "acme",
	directory: "https://acme-staging-v02.api.letsencrypt.org/directory",
	email: "admin@example.edu",
	challenge: {
		mode: "dns01",
		dns: { provider: "cloudflare", fields: { api_token: "tok" } },
	},
};

describe("CertificateJobRequest", () => {
	test.each([
		{ kind: "apply", settings: { source: "internal" } },
		{ kind: "apply", settings: acme },
		{ kind: "test", settings: acme },
		{
			kind: "apply",
			settings: {
				...acme,
				challenge: { mode: "http01" },
				eab: { keyId: "kid", hmacKey: "abc_-=" },
			},
		},
		{
			kind: "apply",
			settings: { source: "files", site: { certificate: PEM, privateKey: PEM } },
		},
		{
			kind: "apply",
			settings: {
				source: "files",
				site: { certificate: PEM },
				preview: { certificate: PEM },
			},
		},
		{ kind: "renew" },
		{ kind: "rollback" },
		{ kind: "check" },
	])("accepts %j", (request) => {
		expect(CertificateJobRequest.safeParse(request).success).toBe(true);
	});

	test.each([
		["reset is not requestable", { kind: "reset" }],
		["test needs acme", { kind: "test", settings: { source: "internal" } }],
		[
			"plain http directory",
			{ kind: "apply", settings: { ...acme, directory: "http://x.test/dir" } },
		],
		[
			"unknown provider",
			{
				kind: "apply",
				settings: {
					...acme,
					challenge: { mode: "dns01", dns: { provider: "bind", fields: {} } },
				},
			},
		],
		[
			"field of another provider",
			{
				kind: "apply",
				settings: {
					...acme,
					challenge: {
						mode: "dns01",
						dns: { provider: "cloudflare", fields: { auth_token: "x" } },
					},
				},
			},
		],
		[
			"newline in a plain field",
			{
				kind: "apply",
				settings: {
					...acme,
					challenge: {
						mode: "dns01",
						dns: {
							provider: "route53",
							fields: { region: "us\n}", access_key_id: "A", secret_access_key: "s" },
						},
					},
				},
			},
		],
		[
			"missing plain field",
			{
				kind: "apply",
				settings: {
					...acme,
					challenge: { mode: "dns01", dns: { provider: "porkbun", fields: {} } },
				},
			},
		],
		["extra key", { kind: "renew", force: true }],
		[
			"not PEM",
			{ kind: "apply", settings: { source: "files", site: { certificate: "hello" } } },
		],
		["bad email", { kind: "apply", settings: { ...acme, email: "nope" } }],
	])("refuses %s", (_name, request) => {
		expect(CertificateJobRequest.safeParse(request).success).toBe(false);
	});

	test("every provider in the enum has a field table", () => {
		expect(Object.keys(DNS_PROVIDER_FIELDS).sort()).toEqual(
			[...DnsProvider.options].sort(),
		);
	});
});

describe("CertificateJobStatusFile", () => {
	const ok = {
		id: ID,
		kind: "apply",
		state: "running",
		step: "Applying",
		message: null,
		restored: false,
		startedAt: NOW,
		finishedAt: null,
	};
	test("accepts a running apply", () => {
		expect(CertificateJobStatusFile.safeParse(ok).success).toBe(true);
	});
	test("refuses queued and a null kind unless refused", () => {
		expect(CertificateJobStatusFile.safeParse({ ...ok, state: "queued" }).success).toBe(
			false,
		);
		expect(CertificateJobStatusFile.safeParse({ ...ok, kind: null }).success).toBe(
			false,
		);
		expect(
			CertificateJobStatusFile.safeParse({ ...ok, kind: null, state: "refused" })
				.success,
		).toBe(true);
	});
});

describe("CertificateStatusFile", () => {
	test("accepts a status with a failed renewal", () => {
		const info = {
			name: "x.test",
			issuer: "R11",
			names: ["x.test"],
			notBefore: NOW,
			notAfter: NOW,
		};
		expect(
			CertificateStatusFile.safeParse({
				checkedAt: NOW,
				source: "acme",
				settings: { source: "internal" },
				previousAvailable: false,
				site: info,
				preview: null,
				lastRenewal: { ok: false, at: NOW, message: "rate limited" },
			}).success,
		).toBe(true);
	});

	test("refuses a settings copy that carries a secret", () => {
		expect(
			CertificateStatusFile.safeParse({
				checkedAt: NOW,
				source: "acme",
				settings: { ...acme, eab: null },
				previousAvailable: false,
				site: null,
				preview: null,
				lastRenewal: null,
			}).success,
		).toBe(false);
	});
});

describe("secret values", () => {
	const withDns = (dns: unknown) => ({
		kind: "apply",
		settings: { ...acme, challenge: { mode: "dns01", dns } },
	});

	test("a token must be one line", () => {
		const dns = { provider: "cloudflare", fields: { api_token: "fake\ntoken" } };
		expect(CertificateJobRequest.safeParse(withDns(dns)).success).toBe(false);
	});

	const serviceAccount = {
		type: "service_account",
		project_id: "demo-project",
		private_key_id: "fake-key-id",
		private_key: "FAKE-PRIVATE-KEY",
		client_email: "caddy@demo-project.iam.gserviceaccount.com",
		client_id: "123",
	};
	const google = (key: unknown) =>
		withDns({
			provider: "googleclouddns",
			fields: {
				gcp_project: "demo-project",
				service_account_json: typeof key === "string" ? key : JSON.stringify(key),
			},
		});

	test("Google's service account is a service-account key file", () => {
		expect(CertificateJobRequest.safeParse(google(serviceAccount)).success).toBe(true);
		expect(CertificateJobRequest.safeParse(google("not json")).success).toBe(false);
	});

	test("a key without the service-account fields is refused", () => {
		expect(
			CertificateJobRequest.safeParse(google({ type: "service_account" })).success,
		).toBe(false);
		const { client_email: _, ...noEmail } = serviceAccount;
		expect(CertificateJobRequest.safeParse(google(noEmail)).success).toBe(false);
		expect(
			CertificateJobRequest.safeParse(
				google({ ...serviceAccount, type: "authorized_user" }),
			).success,
		).toBe(false);
	});

	test("external-account fields that read files or fetch URLs are refused", () => {
		// Google's library would read the file or fetch the URL as caddy (SPEC.md 24.8).
		for (const extra of [
			{ credential_source: { file: "/etc/shadow" } },
			{ token_url: "http://169.254.169.254/" },
			{ external_account_authorized_user: true },
		]) {
			expect(
				CertificateJobRequest.safeParse(google({ ...serviceAccount, ...extra }))
					.success,
			).toBe(false);
		}
	});
});

describe("DNS provider field fixture", () => {
	// The root job's Python tests read this file (docs/SPEC.md section 24.8),
	// so the two sides cannot drift apart.
	test("dns-provider-fields.json matches DNS_PROVIDER_FIELDS", () => {
		const fixture = JSON.parse(
			readFileSync(
				fileURLToPath(new URL("../fixtures/dns-provider-fields.json", import.meta.url)),
				"utf8",
			),
		);
		expect(fixture).toEqual(DNS_PROVIDER_FIELDS);
		expect(Object.keys(fixture).sort()).toEqual([...DnsProvider.options].sort());
	});
});

describe("views hold no secret", () => {
	const secretNames = [
		...Object.values(DNS_PROVIDER_FIELDS).flatMap((p) => p.secret),
		"hmacKey",
		"privateKey",
	];

	test("a view carrying a secret value is refused", () => {
		const view = {
			source: "acme",
			directory: acme.directory,
			email: acme.email,
			eab: { keyId: "kid", hmacKey: "secret" },
			challenge: { mode: "http01" },
		};
		expect(CertificateSettingsView.safeParse(view).success).toBe(false);
		const files = {
			source: "files",
			site: {
				certificate: { issuer: "x", names: [], notBefore: NOW, notAfter: NOW },
				privateKeySet: true,
				privateKey: PEM,
			},
			preview: null,
		};
		expect(CertificateSettingsView.safeParse(files).success).toBe(false);
	});

	test("no view schema names a secret field", () => {
		const keys = new Set<string>();
		const seen = new WeakSet<object>();
		const walk = (value: unknown) => {
			if (!value || typeof value !== "object" || seen.has(value)) return;
			seen.add(value);
			const shape = (value as { shape?: unknown }).shape;
			if (shape && typeof shape === "object")
				for (const k of Object.keys(shape)) keys.add(k);
			for (const v of Object.values(value)) walk(v);
		};
		walk(AdminCertificate);
		expect(keys.has("secretsSet")).toBe(true);
		for (const name of secretNames) expect(keys.has(name)).toBe(false);
	});
});
