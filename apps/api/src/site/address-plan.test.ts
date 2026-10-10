/**
 * The address plan (ADR 0059): every value setup derives
 * from the site address, and the external steps the administrator owns.
 */
import type { CertificateStatusFile, SiteView } from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import {
	addressRefusal,
	hostHeader,
	namesCover,
	planAddress,
	uploadsCover,
} from "./address-plan.js";

const view: SiteView = {
	version: 1,
	apt: true,
	host: "portikus.example.edu",
	port: 8443,
	previewSuffix: "preview.portikus.example.edu",
	previewSuffixSetByHand: false,
	provider: "oidc",
	entraTenantId: null,
	googleDomains: [],
	oidcIssuer: "https://login.example.edu",
	clientId: "portikus",
	clientSecretSet: true,
	groupsClaim: "groups",
	groups: { student: "s", instructor: "i", admin: "a" },
	certificateSource: "internal",
};

const running = [{ id: "w1", label: "alice", ownerName: "Alice" }];
const target = { host: "code.example.edu", port: 443 };

function filesStatus(site: string[], preview?: string[]): CertificateStatusFile {
	const cert = (names: string[]) => ({
		certificate: {
			issuer: "Campus CA",
			names,
			notBefore: "2026-01-01T00:00:00.000Z",
			notAfter: "2027-01-01T00:00:00.000Z",
		},
		privateKeySet: true,
	});
	return {
		checkedAt: "2026-10-10T00:00:00.000Z",
		source: "files",
		settings: {
			source: "files",
			site: cert(site),
			preview: preview ? cert(preview) : null,
		},
		previousAvailable: false,
		site: null,
		preview: null,
		lastRenewal: null,
	};
}

describe("planAddress", () => {
	test("derives the site URL, Dex issuer and Dex callback, dropping port 443", () => {
		const plan = planAddress({ view, target, certificateStatus: null, running });
		expect(plan.siteUrl).toBe("https://code.example.edu");
		expect(plan.dexIssuer).toBe("https://code.example.edu/dex");
		expect(plan.dexCallbackUrl).toBe("https://code.example.edu/dex/callback");
	});

	test("keeps any other port in every URL", () => {
		const plan = planAddress({
			view,
			target: { host: "code.example.edu", port: 9443 },
			certificateStatus: null,
			running,
		});
		expect(plan.siteUrl).toBe("https://code.example.edu:9443");
		expect(plan.dexCallbackUrl).toBe("https://code.example.edu:9443/dex/callback");
		expect(plan.lti.keysetUrl).toBe("https://code.example.edu:9443/lti/jwks");
	});

	test("gives the LTI login, launch and keyset URLs an LMS registers", () => {
		const plan = planAddress({ view, target, certificateStatus: null, running });
		expect(plan.lti).toEqual({
			loginUrl: "https://code.example.edu/lti/login",
			launchUrl: "https://code.example.edu/lti/launch",
			keysetUrl: "https://code.example.edu/lti/jwks",
		});
		expect(plan.checklist.join(" ")).toContain(plan.lti.loginUrl);
	});

	test("the preview wildcard follows the host, and running workspaces keep the old one", () => {
		const plan = planAddress({ view, target, certificateStatus: null, running });
		expect(plan.previewSuffix).toBe("preview.code.example.edu");
		expect(plan.previewWildcard).toBe("*.preview.code.example.edu");
		expect(plan.previewSuffixSetByHand).toBe(false);
		expect(plan.dnsNames).toEqual(["code.example.edu", "*.preview.code.example.edu"]);
		expect(plan.workspacesKeepingOldSuffix).toEqual(running);
	});

	test("a hand-set suffix is kept, so no workspace is listed", () => {
		const byHand = {
			...view,
			previewSuffix: "apps.example.net",
			previewSuffixSetByHand: true,
		};
		const plan = planAddress({
			view: byHand,
			target,
			certificateStatus: null,
			running,
		});
		expect(plan.previewSuffix).toBe("apps.example.net");
		expect(plan.previewWildcard).toBe("*.apps.example.net");
		expect(plan.previewSuffixSetByHand).toBe(true);
		expect(plan.workspacesKeepingOldSuffix).toEqual([]);
	});

	test("the checklist names the redirect address for an upstream provider only", () => {
		const oidc = planAddress({ view, target, certificateStatus: null, running });
		expect(oidc.checklist.some((s) => s.includes(oidc.dexCallbackUrl))).toBe(true);
		const dex = planAddress({
			view: { ...view, provider: "dex" },
			target,
			certificateStatus: null,
			running,
		});
		expect(dex.checklist.some((s) => s.includes(dex.dexCallbackUrl))).toBe(false);
	});

	test("the checklist asks for the new port only when it changes", () => {
		const moved = planAddress({ view, target, certificateStatus: null, running });
		expect(moved.checklist.some((s) => s.includes("port 443"))).toBe(true);
		const same = planAddress({
			view,
			target: { host: "code.example.edu", port: 8443 },
			certificateStatus: null,
			running,
		});
		expect(same.checklist.some((s) => s.includes("Open port"))).toBe(false);
	});

	test("internal and ACME certificates are allowed", () => {
		for (const certificateSource of ["internal", "acme"] as const) {
			const plan = planAddress({
				view: { ...view, certificateSource },
				target,
				certificateStatus: null,
				running,
			});
			expect(plan.certificate).toEqual({ source: certificateSource, allowed: true });
		}
	});

	test("uploaded files are allowed only when they cover the new names", () => {
		const files = { ...view, certificateSource: "files" as const };
		const covering = filesStatus(["code.example.edu", "*.preview.code.example.edu"]);
		const old = filesStatus(["portikus.example.edu", "*.preview.portikus.example.edu"]);
		expect(
			planAddress({ view: files, target, certificateStatus: covering, running })
				.certificate.allowed,
		).toBe(true);
		const refused = planAddress({
			view: files,
			target,
			certificateStatus: old,
			running,
		});
		expect(refused.certificate.allowed).toBe(false);
		expect(refused.certificateNote).toContain("does not cover");
	});
});

describe("uploadsCover", () => {
	test("a separate preview certificate covers the wildcard", () => {
		const status = filesStatus(["code.example.edu"], ["*.preview.code.example.edu"]);
		expect(uploadsCover(status, "code.example.edu", "preview.code.example.edu")).toBe(
			true,
		);
	});

	test("a missing status never counts as covering", () => {
		expect(uploadsCover(null, "code.example.edu", "preview.code.example.edu")).toBe(
			false,
		);
	});
});

describe("namesCover", () => {
	test("a wildcard covers exactly one label", () => {
		expect(namesCover(["*.example.edu"], "code.example.edu")).toBe(true);
		expect(namesCover(["*.example.edu"], "a.code.example.edu")).toBe(false);
		expect(namesCover(["*.example.edu"], "example.edu")).toBe(false);
		expect(namesCover(["Code.Example.edu"], "code.example.edu")).toBe(true);
	});
});

describe("addressRefusal", () => {
	test("refuses the address in force", () => {
		expect(addressRefusal(view, { host: view.host, port: view.port })).toContain(
			"already",
		);
	});

	test("refuses a site under its own preview names", () => {
		const byHand = {
			...view,
			previewSuffix: "example.edu",
			previewSuffixSetByHand: true,
		};
		expect(addressRefusal(byHand, target)).toContain("preview names");
	});

	test("allows a new host or a new port", () => {
		expect(addressRefusal(view, target)).toBeNull();
		expect(addressRefusal(view, { host: view.host, port: 443 })).toBeNull();
	});
});

test("hostHeader leaves out port 443 only", () => {
	expect(hostHeader({ host: "a.example.edu", port: 443 })).toBe("a.example.edu");
	expect(hostHeader({ host: "a.example.edu", port: 8443 })).toBe("a.example.edu:8443");
});
