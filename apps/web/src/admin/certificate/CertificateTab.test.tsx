import {
	ACME_DIRECTORY_PRESETS,
	type AdminCertificate,
	type CertificateJobView,
	type CertificatePreflight,
	type CertificateSettingsView,
	type CertificateStatusFile,
} from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../../test-utils.js";
import { CertificateTab } from "./CertificateTab.js";

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const JOB_ID = "33333333-3333-4333-8333-333333333333";
const PEM = "-----BEGIN CERTIFICATE-----\nMIIfake\n-----END CERTIFICATE-----\n";
// A fake key, split so the secret scanner does not mistake it for a real one.
const KEY = `-----BEGIN ${"PRIVATE"} KEY-----\nMIIfake\n-----END ${"PRIVATE"} KEY-----\n`;

const SETTINGS: CertificateSettingsView = {
	source: "acme",
	directory: ACME_DIRECTORY_PRESETS.letsencrypt,
	email: "it@example.edu",
	eab: null,
	challenge: {
		mode: "dns01",
		provider: "cloudflare",
		fields: {},
		secretsSet: { api_token: true },
	},
};

const STATUS: CertificateStatusFile = {
	checkedAt: "2026-09-30T11:00:00.000Z",
	source: "acme",
	settings: SETTINGS,
	previousAvailable: true,
	site: {
		name: "portikus.example.edu",
		issuer: "CN=R11,O=Let's Encrypt,C=US",
		names: ["portikus.example.edu", "*.preview.portikus.example.edu"],
		notBefore: "2026-09-01T00:00:00.000Z",
		notAfter: "2026-11-30T00:00:00.000Z",
	},
	preview: {
		name: "sample.preview.portikus.example.edu",
		issuer: "CN=R11,O=Let's Encrypt,C=US",
		names: ["portikus.example.edu", "*.preview.portikus.example.edu"],
		notBefore: "2026-09-01T00:00:00.000Z",
		notAfter: "2026-11-30T00:00:00.000Z",
	},
	lastRenewal: { ok: true, at: "2026-09-01T00:00:00.000Z", message: null },
};

function data(over: Partial<AdminCertificate> = {}): AdminCertificate {
	return {
		siteName: "portikus.example.edu",
		previewSuffix: "preview.portikus.example.edu",
		settings: SETTINGS,
		previousAvailable: true,
		status: STATUS,
		job: null,
		rootCertificateAvailable: false,
		...over,
	};
}

function job(over: Partial<CertificateJobView> = {}): CertificateJobView {
	return {
		id: JOB_ID,
		kind: "apply",
		state: "running",
		step: "Testing with the staging directory",
		message: null,
		restored: false,
		requestedAt: null,
		startedAt: "2026-09-30T11:30:00.000Z",
		finishedAt: null,
		request: { kind: "apply", settings: data().settings },
		...over,
	};
}

const PASSED: CertificatePreflight = {
	ok: true,
	checks: [
		{ name: "dns-site", result: "passed", message: "Resolves to 203.0.113.7." },
		{ name: "reach-preview", result: "warning", message: "Did not answer in time." },
	],
};

const FAILED: CertificatePreflight = {
	ok: false,
	checks: [
		{
			name: "dns-preview",
			result: "failed",
			message:
				"x1.preview.portikus.example.edu resolves to 198.51.100.9, not this server.",
		},
	],
};

/** Answers the page's reads with `page`, and records every POST. */
function serve(
	page: AdminCertificate,
	answers: { preflight?: CertificatePreflight; post?: () => Response } = {},
) {
	return stubFetch((url, init) => {
		if (url === "/admin/certificate/preflight")
			return json(200, answers.preflight ?? PASSED);
		if (init?.method === "POST") {
			return answers.post ? answers.post() : json(202, job({ state: "queued" }));
		}
		if (url.startsWith("/admin/certificate/jobs/")) {
			return json(200, { job: page.job ?? job(), log: ["reloading caddy"] });
		}
		return json(200, page);
	});
}

function posted(fetch: ReturnType<typeof stubFetch>, url: string) {
	return fetch.mock.calls
		.filter(([u, init]) => u === url && init?.method === "POST")
		.map(([, init]) => JSON.parse(String(init?.body)));
}

test("says the tab is off when the API answers 404", async () => {
	stubFetch(() => json(404, { code: "NOT_FOUND", message: "Not found." }));
	renderWithQuery(<CertificateTab />);
	expect(
		await screen.findByText("Certificate management is off on this site"),
	).toBeTruthy();
});

test("shows the source, issuer, names, expiry and last renewal", async () => {
	serve(data());
	renderWithQuery(<CertificateTab />);
	expect((await screen.findByTestId("cert-source")).textContent).toBe(
		"ACME with Let's Encrypt, DNS-01 through Cloudflare",
	);
	expect(screen.getByTestId("cert-issuer-site").textContent).toBe(
		"CN=R11,O=Let's Encrypt,C=US",
	);
	const site = screen.getByTestId("cert-row-site");
	expect(within(site).getByText("*.preview.portikus.example.edu")).toBeTruthy();
	expect(screen.getByTestId("cert-expires-site").textContent).toContain("in 60 days");
	expect(screen.getByTestId("cert-last-renewal").textContent).toMatch(/^Succeeded, /);
	expect(screen.queryByTestId("cert-expiry-notice")).toBeNull();
	expect(screen.queryByTestId("cert-root")).toBeNull();
});

test("an expiry inside 14 days and a failed renewal are called out", async () => {
	serve(
		data({
			status: {
				...STATUS,
				site: STATUS.site
					? { ...STATUS.site, notAfter: "2026-10-05T00:00:00.000Z" }
					: null,
				lastRenewal: {
					ok: false,
					at: "2026-09-30T10:00:00.000Z",
					message: "DNS provider said: invalid credentials",
				},
			},
		}),
	);
	renderWithQuery(<CertificateTab />);
	expect((await screen.findByTestId("cert-expiry-notice")).textContent).toContain(
		"expires in 4 days",
	);
	expect(
		within(screen.getByTestId("cert-expires-site")).getByText("Expires soon"),
	).toBeTruthy();
	expect(screen.getByTestId("cert-renewal-notice").textContent).toContain(
		"invalid credentials",
	);
});

test("before the first check the page says so", async () => {
	serve(data({ status: null, settings: null }));
	renderWithQuery(<CertificateTab />);
	expect((await screen.findByTestId("cert-not-checked")).textContent).toContain(
		"has not been checked yet",
	);
	expect(screen.getByTestId("cert-source").textContent).toBe("Unknown");
});

test("Renew now asks for a renewal", async () => {
	const fetch = serve(data());
	renderWithQuery(<CertificateTab />);
	fireEvent.click(await screen.findByTestId("cert-renew"));
	await waitFor(() =>
		expect(posted(fetch, "/admin/certificate/jobs")).toEqual([{ kind: "renew" }]),
	);
});

test("an uploaded certificate has no Renew now, and Roll back says why it is off", async () => {
	const fetch = serve(
		data({
			settings: {
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
			},
			previousAvailable: false,
		}),
	);
	renderWithQuery(<CertificateTab />);
	const rollback = await screen.findByTestId("cert-rollback");
	expect(screen.queryByTestId("cert-renew")).toBeNull();
	expect(rollback.getAttribute("aria-disabled")).toBe("true");
	expect(
		document.getElementById(rollback.getAttribute("aria-describedby") ?? "")
			?.textContent,
	).toBe("There are no earlier settings to roll back to.");
	fireEvent.click(rollback);
	expect(screen.queryByTestId("cert-rollback-confirm")).toBeNull();
	expect(posted(fetch, "/admin/certificate/jobs")).toEqual([]);
});

test("Roll back asks first, then requests it", async () => {
	const fetch = serve(data());
	renderWithQuery(<CertificateTab />);
	fireEvent.click(await screen.findByTestId("cert-rollback"));
	const dialog = await screen.findByTestId("cert-rollback-confirm");
	fireEvent.click(within(dialog).getByRole("button", { name: "Roll back" }));
	await waitFor(() =>
		expect(posted(fetch, "/admin/certificate/jobs")).toEqual([{ kind: "rollback" }]),
	);
});

test("a running job turns every action off and shows its step and log", async () => {
	serve(data({ job: job() }));
	renderWithQuery(<CertificateTab />);
	expect((await screen.findByTestId("cert-job-state")).textContent).toContain(
		"Testing with the staging directory",
	);
	expect(screen.getByTestId("cert-job-kind").textContent).toBe(
		"Apply: ACME with Let's Encrypt, DNS-01 through Cloudflare",
	);
	for (const id of ["cert-renew", "cert-rollback", "cert-test", "cert-apply"]) {
		const button = screen.getByTestId(id);
		expect(button.getAttribute("aria-disabled"), id).toBe("true");
		expect(button.getAttribute("aria-describedby"), id).toBe("cert-busy-note");
	}
	await waitFor(() =>
		expect(screen.getByTestId("cert-job-log").textContent).toContain("reloading caddy"),
	);
});

test("a failed apply says why and that the previous certificate is still in use", async () => {
	serve(
		data({
			job: job({
				state: "failed",
				step: "Put the previous settings back",
				message: "Cloudflare refused the token: Invalid access token",
				restored: true,
				finishedAt: "2026-09-30T11:35:00.000Z",
			}),
		}),
	);
	renderWithQuery(<CertificateTab />);
	expect((await screen.findByTestId("cert-job-message")).textContent).toBe(
		"Cloudflare refused the token: Invalid access token",
	);
	expect(screen.getByTestId("cert-job-restored").textContent).toContain("still in use");
	expect(screen.getByTestId("cert-job-state").textContent).toContain("Failed");
});

test("a stored secret reads as set and starts blank (Epic 27 R8)", async () => {
	serve(data());
	renderWithQuery(<CertificateTab />);
	const token = (await screen.findByLabelText("API token")) as HTMLInputElement;
	expect(token.value).toBe("");
	expect(token.type).toBe("password");
	expect(token.getAttribute("aria-describedby")).toBe("cert-dns-api_token-hint");
	expect(document.getElementById("cert-dns-api_token-hint")?.textContent).toBe(
		"Set. Leave blank to keep it.",
	);
	expect(document.getElementById("cert-eab-hmac-hint")?.textContent).toBe("Not set.");
});

test("Test only runs the checks, then asks for a test with the stored secret kept", async () => {
	const fetch = serve(data());
	renderWithQuery(<CertificateTab />);
	fireEvent.click(await screen.findByTestId("cert-test"));
	expect((await screen.findByTestId("cert-preflight-summary")).textContent).toBe(
		"The checks passed with 1 warning. A DNS-01 certificate does not depend on them.",
	);
	expect(screen.getByTestId("cert-check-reach-preview").textContent).toContain(
		"Did not answer in time.",
	);
	expect(posted(fetch, "/admin/certificate/preflight")).toEqual([{ mode: "dns01" }]);
	await waitFor(() =>
		expect(posted(fetch, "/admin/certificate/jobs")).toEqual([
			{
				kind: "test",
				settings: {
					source: "acme",
					directory: ACME_DIRECTORY_PRESETS.letsencrypt,
					email: "it@example.edu",
					challenge: { mode: "dns01", dns: { provider: "cloudflare", fields: {} } },
				},
			},
		]),
	);
	expect(screen.getByTestId("cert-test-note").textContent).toContain(
		"Let's Encrypt staging",
	);
});

test("a failed check blocks Apply and names the name that is wrong", async () => {
	const fetch = serve(data(), { preflight: FAILED });
	renderWithQuery(<CertificateTab />);
	fireEvent.click(await screen.findByTestId("cert-apply"));
	expect((await screen.findByTestId("cert-preflight-summary")).textContent).toBe(
		"1 check failed. Fix it and try again.",
	);
	expect(screen.getByTestId("cert-check-dns-preview").textContent).toContain(
		"x1.preview.portikus.example.edu resolves to 198.51.100.9",
	);
	expect(screen.queryByTestId("cert-apply-confirm")).toBeNull();
	expect(posted(fetch, "/admin/certificate/jobs")).toEqual([]);
});

test("ZeroSSL says its test gets a real certificate (R11 amendment)", async () => {
	const settings = data().settings;
	serve(
		data({
			settings:
				settings?.source === "acme"
					? { ...settings, directory: ACME_DIRECTORY_PRESETS.zerossl }
					: settings,
		}),
	);
	renderWithQuery(<CertificateTab />);
	expect((await screen.findByTestId("cert-test-note")).textContent).toBe(
		"ZeroSSL has no test service, so Test only gets a real certificate from it. The test certificate is kept apart and never put in use.",
	);
});

test("a missing field stops Apply and takes focus", async () => {
	const fetch = serve(data({ settings: { source: "internal" } }));
	renderWithQuery(<CertificateTab />);
	fireEvent.click(await screen.findByTestId("cert-source-acme"));
	fireEvent.click(screen.getByTestId("cert-apply"));
	const email = screen.getByLabelText("Account email");
	await waitFor(() => expect(document.activeElement).toBe(email));
	expect(email.getAttribute("aria-invalid")).toBe("true");
	expect(screen.getByText("Enter the account email.")).toBeTruthy();
	expect(screen.getByText("Enter the API token.")).toBeTruthy();
	expect(posted(fetch, "/admin/certificate/preflight")).toEqual([]);
});

test("HTTP-01 explains port 80 and sends no DNS fields", async () => {
	const fetch = serve(data());
	renderWithQuery(<CertificateTab />);
	fireEvent.click(await screen.findByTestId("cert-mode-http01"));
	expect(screen.getByTestId("cert-http01-note").textContent).toContain("Port 80");
	expect(screen.queryByTestId("cert-dns")).toBeNull();
	fireEvent.click(screen.getByTestId("cert-apply"));
	const dialog = await screen.findByTestId("cert-apply-confirm");
	expect(posted(fetch, "/admin/certificate/preflight")).toEqual([{ mode: "http01" }]);
	fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
	await waitFor(() =>
		expect(posted(fetch, "/admin/certificate/jobs")).toEqual([
			{
				kind: "apply",
				settings: {
					source: "acme",
					directory: ACME_DIRECTORY_PRESETS.letsencrypt,
					email: "it@example.edu",
					challenge: { mode: "http01" },
				},
			},
		]),
	);
});

test("switching to the internal authority asks first and needs no checks", async () => {
	const fetch = serve(data());
	renderWithQuery(<CertificateTab />);
	fireEvent.click(await screen.findByTestId("cert-source-internal"));
	expect(screen.queryByTestId("cert-test")).toBeNull();
	fireEvent.click(screen.getByTestId("cert-apply"));
	const dialog = await screen.findByTestId("cert-apply-confirm");
	expect(dialog.textContent).toContain("Switch to the internal authority?");
	fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
	await waitFor(() =>
		expect(posted(fetch, "/admin/certificate/jobs")).toEqual([
			{ kind: "apply", settings: { source: "internal" } },
		]),
	);
	expect(posted(fetch, "/admin/certificate/preflight")).toEqual([]);
});

/** Choose a file in the site certificate's fieldset; the preview one has the same labels. */
function choose(label: string, text: string, name: string) {
	const input = within(screen.getByTestId("cert-upload-site")).getByLabelText(label);
	fireEvent.change(input, { target: { files: [new File([text], name)] } });
	return input;
}

test("an upload the API refuses names the failed check, and the key never leaves the request", async () => {
	const fetch = serve(data({ settings: { source: "internal" } }), {
		post: () =>
			json(400, {
				code: "CERTIFICATE_UPLOAD_REFUSED",
				message:
					"Site certificate: the key-matches check failed. The private key does not match the certificate.",
			}),
	});
	renderWithQuery(<CertificateTab />);
	fireEvent.click(await screen.findByTestId("cert-source-files"));
	choose("Certificate", PEM, "site.crt");
	choose("Private key", KEY, "site.key");
	await waitFor(() =>
		expect(screen.queryByText("Choose the private key file.")).toBeNull(),
	);
	fireEvent.click(screen.getByTestId("cert-apply"));
	const dialog = await screen.findByTestId("cert-apply-confirm");
	fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
	expect((await screen.findByTestId("cert-form-error")).textContent).toBe(
		'Site certificate: failed the check "Key matches the certificate". The private key does not match the certificate.',
	);
	expect(posted(fetch, "/admin/certificate/jobs")).toEqual([
		{
			kind: "apply",
			settings: { source: "files", site: { certificate: PEM, privateKey: KEY } },
		},
	]);
	expect(document.body.textContent).not.toContain("MIIfake");
});

test("a file that is not PEM is refused where it was chosen", async () => {
	serve(data({ settings: { source: "internal" } }));
	renderWithQuery(<CertificateTab />);
	fireEvent.click(await screen.findByTestId("cert-source-files"));
	const input = choose("Certificate", "binary DER bytes", "site.der");
	expect(await screen.findByText(/not in PEM format/)).toBeTruthy();
	expect(input.getAttribute("aria-invalid")).toBe("true");
});

test("the root certificate is offered for download with install steps", async () => {
	serve(data({ settings: { source: "internal" }, rootCertificateAvailable: true }));
	renderWithQuery(<CertificateTab />);
	const link = await screen.findByRole("link", { name: "Download root certificate" });
	expect(link.getAttribute("href")).toBe("/admin/certificate/root.crt");
	expect(link.hasAttribute("download")).toBe(true);
	expect(screen.getByTestId("cert-root").textContent).toContain(
		"update-ca-certificates",
	);
});
