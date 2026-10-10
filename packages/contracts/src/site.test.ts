import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
	AddressSettings,
	AdminLtiPlatform,
	isSitePort,
	isSiteText,
	LtiPlatformsUpdate,
	MAX_ADMIN_LTI_PLATFORMS,
	MAX_PROXY_HOSTS,
	ProxyHostsUpdate,
	SITE_RESERVED_PORTS,
	SigninSettings,
	SigninView,
	SiteJobRequest,
	SiteJobStatusFile,
	SiteView,
} from "./site.js";

const ID = "550e8400-e29b-41d4-a716-446655440000";
const HEAD = { version: 1, id: ID, requestedAt: "2026-10-10T12:00:00.000Z" };

const PLATFORM = {
	name: "Canvas",
	issuer: "https://canvas.instructure.com",
	clientId: "10000000000001",
	authLoginUrl: "https://school.instructure.com/api/lti/authorize_redirect",
	keysetUrl: "https://sso.canvaslms.com/api/lti/security/jwks",
	deploymentIds: ["1:abc123"],
	mock: false,
};

const OIDC = {
	provider: "oidc",
	oidcIssuer: "https://login.example.edu/realms/main",
	clientId: "portikus",
	clientSecret: "s".repeat(24),
	groupsClaim: "groups",
	groups: {
		student: "portikus-students",
		instructor: "portikus-instructors",
		admin: "portikus-administrators",
	},
};

const VIEW = {
	version: 1,
	apt: true,
	host: "portikus.example.edu",
	port: 443,
	previewSuffix: "preview.portikus.example.edu",
	previewSuffixSetByHand: false,
	provider: "oidc",
	entraTenantId: null,
	googleDomains: [],
	oidcIssuer: "https://login.example.edu/realms/main",
	clientId: "portikus",
	clientSecretSet: true,
	groupsClaim: "groups",
	groups: {
		student: "portikus-students",
		instructor: "portikus-instructors",
		admin: "portikus-administrators",
	},
	certificateSource: "internal",
};

/** Every way a value could carry a template or a control character into the root job. */
const HOSTILE = [
	"{{ 7*7 }}",
	"a{b",
	"a}b",
	"a\nb",
	"a\tb",
	"a\u0000b",
	"a\u007fb",
	"a\u0085b",
];

describe("isSiteText (ADR 0059)", () => {
	test("plain text passes", () => {
		expect(isSiteText("Canvas at Example University (2026)")).toBe(true);
	});
	test.each(HOSTILE)("refuses %j", (value) => {
		expect(isSiteText(value)).toBe(false);
	});
});

describe("SiteJobRequest", () => {
	test("accepts one good request of every kind", () => {
		const good = [
			{ ...HEAD, kind: "proxy-hosts", hosts: ["api.github.com", "pypi.org"] },
			{ ...HEAD, kind: "lti-platforms", platforms: [PLATFORM] },
			{ ...HEAD, kind: "lti-platforms", platforms: [] },
			{ ...HEAD, kind: "address", host: "portikus.example.edu", port: 443 },
			{ ...HEAD, kind: "address", host: "portikus.example.edu", port: 8443 },
			{ ...HEAD, kind: "signin", ...OIDC },
			{ ...HEAD, kind: "signin", provider: "dex", clientSecret: null },
			{ ...HEAD, kind: "keep", trialId: ID },
			{ ...HEAD, kind: "rollback", trialId: ID },
		];
		for (const request of good) {
			expect(SiteJobRequest.safeParse(request).success, request.kind).toBe(true);
		}
	});

	test("refuses an unknown kind, a missing head and an extra field", () => {
		expect(SiteJobRequest.safeParse({ ...HEAD, kind: "reboot" }).success).toBe(false);
		expect(
			SiteJobRequest.safeParse({ kind: "keep", trialId: ID, id: ID, version: 1 })
				.success,
		).toBe(false);
		expect(
			SiteJobRequest.safeParse({ ...HEAD, version: 2, kind: "keep", trialId: ID })
				.success,
		).toBe(false);
		expect(
			SiteJobRequest.safeParse({ ...HEAD, kind: "keep", trialId: ID, extra: 1 })
				.success,
		).toBe(false);
		expect(
			SiteJobRequest.safeParse({ ...HEAD, kind: "keep", trialId: "x" }).success,
		).toBe(false);
	});

	test.each(HOSTILE)("refuses %j in a signin text field", (value) => {
		for (const field of ["clientId", "oidcIssuer", "groupsClaim", "clientSecret"]) {
			const request = { ...HEAD, kind: "signin", ...OIDC, [field]: value };
			expect(SiteJobRequest.safeParse(request).success, field).toBe(false);
		}
		const groups = { ...OIDC.groups, student: value };
		expect(
			SiteJobRequest.safeParse({ ...HEAD, kind: "signin", ...OIDC, groups }).success,
		).toBe(false);
	});

	test.each(HOSTILE)("refuses %j in a platform field", (value) => {
		for (const field of ["name", "clientId", "issuer", "keysetUrl"]) {
			const platforms = [{ ...PLATFORM, [field]: value }];
			expect(
				SiteJobRequest.safeParse({ ...HEAD, kind: "lti-platforms", platforms }).success,
				field,
			).toBe(false);
		}
		const platforms = [{ ...PLATFORM, deploymentIds: [value] }];
		expect(
			SiteJobRequest.safeParse({ ...HEAD, kind: "lti-platforms", platforms }).success,
		).toBe(false);
	});

	test.each(HOSTILE)("refuses %j as a host", (value) => {
		expect(
			SiteJobRequest.safeParse({ ...HEAD, kind: "proxy-hosts", hosts: [value] })
				.success,
		).toBe(false);
		expect(
			SiteJobRequest.safeParse({ ...HEAD, kind: "address", host: value, port: 443 })
				.success,
		).toBe(false);
	});
});

describe("ProxyHostsUpdate (ADR 0059)", () => {
	test("refuses addresses, ports, URLs, repeats and too many hosts", () => {
		for (const host of [
			"10.0.0.1",
			"[::1]",
			"::1",
			"example.com:8443",
			"https://example.com",
		]) {
			expect(ProxyHostsUpdate.safeParse({ hosts: [host] }).success, host).toBe(false);
		}
		expect(ProxyHostsUpdate.safeParse({ hosts: ["a.org", "a.org"] }).success).toBe(
			false,
		);
		const many = Array.from(
			{ length: MAX_PROXY_HOSTS + 1 },
			(_, i) => `h${i}.example.org`,
		);
		expect(ProxyHostsUpdate.safeParse({ hosts: many }).success).toBe(false);
		expect(ProxyHostsUpdate.safeParse({ hosts: many.slice(1) }).success).toBe(true);
	});
});

describe("AdminLtiPlatform (ADR 0059)", () => {
	test("takes an optional https authTokenUrl on the default port", () => {
		const authTokenUrl = "https://sso.canvaslms.com/login/oauth2/token";
		expect(AdminLtiPlatform.safeParse({ ...PLATFORM, authTokenUrl }).success).toBe(
			true,
		);
		for (const bad of [
			"http://sso.canvaslms.com/token",
			"https://sso.canvaslms.com:8443/token",
			"https://10.0.0.1/token",
		]) {
			expect(
				AdminLtiPlatform.safeParse({ ...PLATFORM, authTokenUrl: bad }).success,
				bad,
			).toBe(false);
		}
	});

	test("refuses a mock, http, a keyset off port 443 and a missing deployment", () => {
		expect(AdminLtiPlatform.safeParse({ ...PLATFORM, mock: true }).success).toBe(false);
		expect(
			AdminLtiPlatform.safeParse({ ...PLATFORM, issuer: "http://canvas.example.edu" })
				.success,
		).toBe(false);
		expect(
			AdminLtiPlatform.safeParse({
				...PLATFORM,
				keysetUrl: "https://canvas.example.edu:8443/jwks",
			}).success,
		).toBe(false);
		expect(
			AdminLtiPlatform.safeParse({
				...PLATFORM,
				keysetUrl: "https://user:pw@canvas.example.edu/jwks",
			}).success,
		).toBe(false);
		expect(AdminLtiPlatform.safeParse({ ...PLATFORM, deploymentIds: [] }).success).toBe(
			false,
		);
	});

	test("the list refuses repeats and more than the cap", () => {
		const second = { ...PLATFORM, name: "Canvas 2" };
		expect(
			LtiPlatformsUpdate.safeParse({ platforms: [PLATFORM, second] }).success,
		).toBe(false);
		expect(
			LtiPlatformsUpdate.safeParse({
				platforms: [PLATFORM, { ...PLATFORM, clientId: "2" }],
			}).success,
		).toBe(false);
		const many = Array.from({ length: MAX_ADMIN_LTI_PLATFORMS + 1 }, (_, i) => ({
			...PLATFORM,
			name: `P${i}`,
			clientId: `${i}`,
		}));
		expect(LtiPlatformsUpdate.safeParse({ platforms: many }).success).toBe(false);
		expect(LtiPlatformsUpdate.safeParse({ platforms: many.slice(1) }).success).toBe(
			true,
		);
	});
});

describe("one keyset per issuer", () => {
	// Accounts are keyed by issuer and subject, so a second keyset could sign in as them.
	test("a second platform of one issuer needs the same keyset", () => {
		const other = { ...PLATFORM, name: "Canvas 2", clientId: "2" };
		expect(LtiPlatformsUpdate.safeParse({ platforms: [PLATFORM, other] }).success).toBe(
			true,
		);
		expect(
			LtiPlatformsUpdate.safeParse({
				platforms: [PLATFORM, { ...other, keysetUrl: "https://evil.example.com/jwks" }],
			}).success,
		).toBe(false);
	});
});

describe("the values the root job agrees on (ADR 0059)", () => {
	const fixture = JSON.parse(
		readFileSync(
			fileURLToPath(
				new URL("../../../packaging/site/tests/fixtures/values.json", import.meta.url),
			),
			"utf8",
		),
	) as { fields: Record<string, { good: unknown[]; bad: unknown[] }> };

	// Each fixture field, as a schema given a body holding the value.
	const FIELDS: Record<string, (value: unknown) => boolean> = {
		httpsUrl: (v) =>
			AdminLtiPlatform.safeParse({ ...PLATFORM, authLoginUrl: v }).success,
		keysetUrl: (v) => AdminLtiPlatform.safeParse({ ...PLATFORM, keysetUrl: v }).success,
		oidcIssuer: (v) => SigninSettings.safeParse({ ...OIDC, oidcIssuer: v }).success,
		proxyHost: (v) => ProxyHostsUpdate.safeParse({ hosts: [v] }).success,
		siteHost: (v) => AddressSettings.safeParse({ host: v, port: 443 }).success,
		sitePort: (v) =>
			AddressSettings.safeParse({ host: "portikus.example.edu", port: v }).success,
	};

	for (const [field, accepts] of Object.entries(FIELDS)) {
		test(`${field}: every good value passes and every bad one is refused`, () => {
			const values = fixture.fields[field];
			expect(values, field).toBeDefined();
			for (const value of values?.good ?? []) {
				expect(accepts(value), `good ${JSON.stringify(value)}`).toBe(true);
			}
			for (const value of values?.bad ?? []) {
				expect(accepts(value), `bad ${JSON.stringify(value)}`).toBe(false);
			}
		});
	}
});

describe("AddressSettings (ADR 0059)", () => {
	test("takes 443 or a free port from 1024 up", () => {
		expect(isSitePort(443)).toBe(true);
		expect(isSitePort(1024)).toBe(true);
		expect(isSitePort(65535)).toBe(true);
		for (const port of [0, 80, 444, 1023, 65536, 8443.5, ...SITE_RESERVED_PORTS]) {
			expect(isSitePort(port), String(port)).toBe(false);
		}
	});

	test("refuses an address, a bare name, capitals and a port in the host", () => {
		for (const host of [
			"10.0.0.1",
			"portikus",
			"Portikus.example.edu",
			"a.example.edu:443",
		]) {
			expect(AddressSettings.safeParse({ host, port: 443 }).success, host).toBe(false);
		}
		expect(
			AddressSettings.safeParse({ host: "portikus.10.0.0.1.nip.io", port: 8443 })
				.success,
		).toBe(true);
	});
});

describe("SigninSettings (ADR 0059)", () => {
	test("each provider needs its own fields", () => {
		expect(
			SigninSettings.safeParse({ provider: "oidc", clientSecret: null }).success,
		).toBe(false);
		expect(
			SigninSettings.safeParse({
				provider: "entra",
				entraTenantId: "12345678-90ab-cdef-1234-567890abcdef",
				clientId: "8f2c0b6e-1111-2222-3333-444455556666",
				clientSecret: null,
			}).success,
		).toBe(true);
		expect(
			SigninSettings.safeParse({
				provider: "google",
				googleDomains: ["example.edu"],
				clientId: "123-abc.apps.googleusercontent.com",
				clientSecret: null,
			}).success,
		).toBe(true);
		expect(
			SigninSettings.safeParse({
				provider: "google",
				clientId: "x",
				clientSecret: null,
			}).success,
		).toBe(false);
	});

	test("refuses LDAP, a short secret, a bad tenant and a secret for Dex", () => {
		expect(
			SigninSettings.safeParse({ provider: "ldap", clientSecret: null }).success,
		).toBe(false);
		expect(SigninSettings.safeParse({ ...OIDC, clientSecret: "short" }).success).toBe(
			false,
		);
		expect(
			SigninSettings.safeParse({
				provider: "entra",
				entraTenantId: "not-a-tenant",
				clientId: "x",
				clientSecret: null,
			}).success,
		).toBe(false);
		expect(
			SigninSettings.safeParse({ provider: "dex", clientSecret: "s".repeat(16) })
				.success,
		).toBe(false);
		expect(
			SigninSettings.safeParse({ ...OIDC, oidcIssuer: "http://login.example.edu" })
				.success,
		).toBe(false);
	});
});

describe("SiteView: no secret can be read through it (SPEC.md 24.8)", () => {
	test("a well-formed view parses", () => {
		expect(SiteView.safeParse(VIEW).success).toBe(true);
		expect(
			SiteView.safeParse({ ...VIEW, provider: "ldap", ldapHost: "ad.example.edu" })
				.success,
		).toBe(true);
	});

	test.each([
		["clientSecret", "s".repeat(24)],
		["ldapBindPassword", "pw"],
		["cloudflareApiToken", "tok"],
	])("a view holding %s is refused", (key, value) => {
		expect(SiteView.safeParse({ ...VIEW, [key]: value }).success).toBe(false);
		expect(SigninView.safeParse({ ...VIEW, [key]: value }).success).toBe(false);
	});

	test("clientSecretSet is a flag, never a string", () => {
		expect(
			SiteView.safeParse({ ...VIEW, clientSecretSet: "s".repeat(16) }).success,
		).toBe(false);
		expect(Object.keys(SiteView.shape).filter((k) => /secret/i.test(k))).toEqual([
			"clientSecretSet",
		]);
	});
});

describe("SiteJobStatusFile", () => {
	const status = {
		id: ID,
		kind: "address",
		state: "trial",
		code: null,
		startedAt: "2026-10-10T12:00:00.000Z",
		finishedAt: null,
		trialEndsAt: "2026-10-10T12:15:00.000Z",
	};
	test("parses a trial and refuses a free-text code or a queued state", () => {
		expect(SiteJobStatusFile.safeParse(status).success).toBe(true);
		expect(
			SiteJobStatusFile.safeParse({ ...status, code: "setup said no" }).success,
		).toBe(false);
		expect(SiteJobStatusFile.safeParse({ ...status, state: "queued" }).success).toBe(
			false,
		);
		expect(SiteJobStatusFile.safeParse({ ...status, clientSecret: "x" }).success).toBe(
			false,
		);
	});
});
