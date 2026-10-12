import type { AdminSignin, SiteJobView } from "@portikus/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../../test-utils.js";
import { SsoGroup } from "./SsoGroup.js";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const TRIAL = "11111111-2222-4333-8444-555555555555";

const CURRENT: NonNullable<AdminSignin["current"]> = {
	provider: "oidc",
	entraTenantId: null,
	googleDomains: [],
	oidcIssuer: "https://login.example.edu",
	clientId: "portikus",
	clientSecretSet: true,
	groupsClaim: "groups",
	groups: { student: "students", instructor: "teachers", admin: "admins" },
};

function trialJob(): SiteJobView {
	return {
		id: TRIAL,
		kind: "signin",
		state: "trial",
		code: null,
		requestedAt: null,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		trialEndsAt: new Date(Date.now() + 29 * 60_000).toISOString(),
	};
}

function serve(page: AdminSignin) {
	return stubFetch((_url, init) => {
		if (init?.method === "POST") {
			return json(202, {
				...trialJob(),
				kind: null,
				state: "queued",
				requestedAt: new Date().toISOString(),
				trialEndsAt: null,
			});
		}
		return json(200, page);
	});
}

test("off an apt install it says single sign-on is unavailable", async () => {
	serve({ current: null, job: null, lastTest: null });
	renderWithQuery(<SsoGroup />);
	expect((await screen.findByTestId("sso-unavailable")).textContent).toContain(
		"installed with apt",
	);
	expect(screen.queryByTestId("sso-apply")).toBeNull();
});

test("LDAP shows read-only with the dpkg-reconfigure note", async () => {
	serve({
		current: {
			...CURRENT,
			provider: "ldap",
			clientId: null,
			ldapHost: "ad.example.edu",
		},
		job: null,
		lastTest: null,
	});
	renderWithQuery(<SsoGroup />);
	expect((await screen.findByTestId("sso-ldap-note")).textContent).toContain(
		"dpkg-reconfigure portikus",
	);
	expect(screen.getByTestId("sso-current").textContent).toContain("ad.example.edu");
	expect(screen.queryByRole("radio", { name: /LDAP/ })).toBeNull();
});

test("the secret is write-only and Apply asks first, naming the lockout risk", async () => {
	const fetch = serve({ current: CURRENT, job: null, lastTest: null });
	renderWithQuery(<SsoGroup />);
	const secret = (await screen.findByLabelText("Client secret")) as HTMLInputElement;
	expect(secret.type).toBe("password");
	expect(secret.value).toBe("");
	fireEvent.change(secret, { target: { value: "a-brand-new-secret-123" } });
	fireEvent.click(screen.getByTestId("sso-apply"));
	const dialog = await screen.findByTestId("sso-apply-confirm");
	expect(dialog.textContent).toContain("students cannot sign in");
	expect(dialog.textContent).toContain("local administrator's password always works");
	fireEvent.click(within(dialog).getByRole("button", { name: "Apply as a trial" }));
	await waitFor(() =>
		expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true),
	);
	const [, init] = fetch.mock.calls.find(([, i]) => i?.method === "POST") ?? [];
	expect(JSON.parse(String(init?.body))).toMatchObject({
		provider: "oidc",
		clientSecret: "a-brand-new-secret-123",
	});
	await waitFor(() =>
		expect((screen.getByLabelText("Client secret") as HTMLInputElement).value).toBe(""),
	);
});

test("a changed client ID with no secret is stopped on the page", async () => {
	const fetch = serve({ current: CURRENT, job: null, lastTest: null });
	renderWithQuery(<SsoGroup />);
	fireEvent.change(await screen.findByLabelText("Client ID"), {
		target: { value: "portikus-2" },
	});
	fireEvent.click(screen.getByTestId("sso-apply"));
	await waitFor(() =>
		expect(screen.getByLabelText("Client secret").getAttribute("aria-invalid")).toBe(
			"true",
		),
	);
	expect(screen.queryByTestId("sso-apply-confirm")).toBeNull();
	expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

test("in a trial, Keep stays off until a test of this trial passes", async () => {
	serve({ current: CURRENT, job: trialJob(), lastTest: null });
	renderWithQuery(<SsoGroup />);
	const keep = await screen.findByTestId("sso-keep");
	expect(keep.getAttribute("aria-disabled")).toBe("true");
	expect(screen.getByTestId("sso-trial-left").textContent).toMatch(/^2[89]:\d\d$/);
	expect(screen.getByTestId("sso-test").closest("form")).toBeNull();
	expect(screen.getByTestId("sso-job").textContent).toContain("on trial");
	expect(screen.queryByTestId("sso-apply")).toBeNull();
});

test("a passing test turns Keep on and says the role", async () => {
	const fetch = serve({
		current: CURRENT,
		job: trialJob(),
		lastTest: {
			trialId: TRIAL,
			result: "passed",
			role: "student",
			connector: "oidc",
			at: new Date().toISOString(),
		},
	});
	renderWithQuery(<SsoGroup />);
	const keep = await screen.findByTestId("sso-keep");
	expect(keep.getAttribute("aria-disabled")).toBeNull();
	expect(screen.getByTestId("sso-test-result").textContent).toContain("as a student");
	fireEvent.click(keep);
	await waitFor(() =>
		expect(
			fetch.mock.calls.some(
				([url, init]) => url === "/admin/signin/keep" && init?.method === "POST",
			),
		).toBe(true),
	);
});

test("Dex only can be kept at once, with no test", async () => {
	serve({
		current: { ...CURRENT, provider: "dex", clientId: null, clientSecretSet: false },
		job: trialJob(),
		lastTest: null,
	});
	renderWithQuery(<SsoGroup />);
	const keep = await screen.findByTestId("sso-keep");
	expect(keep.getAttribute("aria-disabled")).toBeNull();
	expect(screen.queryByTestId("sso-test")).toBeNull();
});

// A trial starting moves focus to its sentence only from the body or this group (SPEC.md section 25.8).
test.each([
	["the body", false, true],
	["another group", true, false],
])("a trial starting with focus on %s", async (_where, outside, moves) => {
	let page: AdminSignin = { current: CURRENT, job: null, lastTest: null };
	stubFetch(() => json(200, page));
	const client = renderWithQuery(
		<>
			<button type="button">Elsewhere</button>
			<SsoGroup />
		</>,
	);
	await screen.findByTestId("sso-current");
	if (outside) screen.getByRole("button", { name: "Elsewhere" }).focus();
	page = { ...page, job: trialJob() };
	await client.invalidateQueries();
	await screen.findByTestId("sso-keep");
	const text = document.getElementById("sso-trial-text");
	await waitFor(() => expect(document.activeElement === text).toBe(moves));
	if (!moves) expect(document.activeElement?.textContent).toBe("Elsewhere");
});

test("Google group checks show the write-only key and groups, and send the key once", async () => {
	const key = JSON.stringify({
		type: "service_account",
		project_id: "portikus-test",
		private_key_id: "fake-key-id",
		private_key:
			"-----BEGIN FAKE TEST KEY-----\nnot-a-real-key\n-----END FAKE TEST KEY-----\n",
		client_email: "groups@portikus-test.iam.gserviceaccount.com",
	});
	const fetch = serve({
		current: {
			...CURRENT,
			provider: "google",
			googleDomains: ["example.edu"],
			oidcIssuer: null,
			groupsClaim: null,
			googleAdminEmail: null,
			googleKeySet: false,
		},
		job: null,
		lastTest: null,
	});
	renderWithQuery(<SsoGroup />);
	const admin = await screen.findByLabelText("Administrator to read groups as");
	// Fields appear below it as it is filled, so its hint says so before they do.
	expect(
		document.getElementById(admin.getAttribute("aria-describedby") ?? "")?.textContent,
	).toContain("Filling it in adds a key and three group fields below.");
	expect(screen.queryByLabelText("Service account key")).toBeNull();
	expect(screen.queryByLabelText("Students' group")).toBeNull();
	fireEvent.change(admin, { target: { value: "groups-reader@example.edu" } });
	const field = screen.getByLabelText("Service account key") as HTMLTextAreaElement;
	expect(field.value).toBe("");
	expect(screen.getByTestId("sso-groups-note").textContent).toContain("cannot join");
	// The invite-only note is read with the group fields' fieldset.
	expect(
		screen
			.getByRole("group", { name: "Roles from groups" })
			.getAttribute("aria-describedby"),
	).toBe("sso-groups-note");
	fireEvent.change(field, { target: { value: key } });
	for (const [label, value] of [
		["Students' group", "students@example.edu"],
		["Instructors' group", "staff@example.edu"],
		["Administrators' group", "it@example.edu"],
	] as const) {
		fireEvent.change(screen.getByLabelText(label), { target: { value } });
	}
	fireEvent.click(screen.getByTestId("sso-apply"));
	const dialog = await screen.findByTestId("sso-apply-confirm");
	fireEvent.click(within(dialog).getByRole("button", { name: "Apply as a trial" }));
	await waitFor(() =>
		expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true),
	);
	const [, init] = fetch.mock.calls.find(([, i]) => i?.method === "POST") ?? [];
	expect(JSON.parse(String(init?.body))).toMatchObject({
		provider: "google",
		googleAdminEmail: "groups-reader@example.edu",
		googleServiceAccountKey: key,
		groups: { student: "students@example.edu" },
	});
	// The key is with the job now; the page keeps none of it.
	await waitFor(() =>
		expect(
			(screen.getByLabelText("Service account key") as HTMLTextAreaElement).value,
		).toBe(""),
	);
});
