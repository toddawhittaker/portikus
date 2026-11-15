/** Settings, API keys (SPEC.md sections 24.8 and 24.13). */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../test-utils.js";
import { ApiKeysPane } from "./ApiKeysPane.js";
import { defaultPeriod } from "./CreateApiKeyForm.js";
import { newPeriodText } from "./RotateApiKeyDialog.js";

vi.mock("@simplewebauthn/browser", () => ({
	browserSupportsWebAuthn: () => true,
	startAuthentication: vi.fn(async () => ({
		id: "cred",
		rawId: "cred",
		type: "public-key",
	})),
}));

const ACTIVE = {
	id: "11111111-1111-4111-8111-111111111111",
	name: "Claude on my laptop",
	prefix: "portikus_aaaa",
	scope: "read",
	periodDays: 30,
	state: "active",
	createdAt: "2026-11-01T10:00:00.000Z",
	expiresAt: "2026-12-01T10:00:00.000Z",
	lastUsedAt: null,
	revokedAt: null,
};
const REVOKED = {
	...ACTIVE,
	id: "22222222-2222-4222-8222-222222222222",
	name: "Old key",
	prefix: "portikus_bbbb",
	state: "revoked",
	revokedAt: "2026-11-10T10:00:00.000Z",
};
const SECRET = "portikus_cccc_the-secret-shown-once";

let keys: object[];
let periods: (number | null)[];
let calls: { url: string; method: string; body: unknown }[];

beforeEach(() => {
	keys = [ACTIVE, REVOKED];
	periods = [30];
	calls = [];
	stubFetch((url, init) => {
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : null;
		calls.push({ url, method, body });
		if (url === "/me/api-keys" && method === "GET") return json(200, { keys, periods });
		if (url === "/me/api-keys" && method === "POST") {
			if (body.code === "000000")
				return json(403, { code: "WRONG_CODE", message: "That code is not right." });
			const key = {
				...ACTIVE,
				id: "33333333-3333-4333-8333-333333333333",
				name: body.name,
				prefix: "portikus_cccc",
			};
			keys = [key, ...keys];
			return json(201, { key, secret: SECRET });
		}
		if (url === "/me/second-factor")
			return json(200, {
				factors: [
					{
						id: "44444444-4444-4444-8444-444444444444",
						kind: "webauthn",
						label: "Laptop",
						createdAt: ACTIVE.createdAt,
						lastUsedAt: null,
					},
				],
				recoveryCodesLeft: 5,
			});
		if (url === "/me/api-keys/passkey/start")
			return json(200, { challenge: "abc", rpId: "x" });
		if (url === `/me/api-keys/${ACTIVE.id}/renew`)
			return json(200, { ...ACTIVE, expiresAt: "2027-01-01T10:00:00.000Z" });
		if (url === `/me/api-keys/${ACTIVE.id}/rotate` && body?.code === "000000")
			return json(403, { code: "WRONG_CODE", message: "That code is not right." });
		if (url === `/me/api-keys/${ACTIVE.id}/rotate`)
			return json(200, {
				key: { ...ACTIVE, prefix: "portikus_dddd" },
				secret: "portikus_dddd_new",
			});
		if (url === `/me/api-keys/${ACTIVE.id}/revoke`) {
			keys = [
				{ ...ACTIVE, state: "revoked", revokedAt: "2026-11-15T10:00:00.000Z" },
				REVOKED,
			];
			return json(200, { affected: 1 });
		}
		throw new Error(`unexpected request to ${method} ${url}`);
	});
});

afterEach(() => vi.unstubAllGlobals());

/** Open the create form once the list has loaded and the button is live. */
async function openCreate() {
	const button = await screen.findByRole("button", { name: "Create an API key" });
	await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
	fireEvent.click(button);
}

function row(prefix: string) {
	return within(screen.getByTestId(`api-key-${prefix}`));
}

test("each key shows its name, prefix, access, state, expiry and last use", async () => {
	renderWithQuery(<ApiKeysPane highlightId={null} needsSecondFactor={false} />);
	await screen.findByTestId("api-key-portikus_aaaa");
	const active = row("portikus_aaaa");
	expect(active.getByText("Claude on my laptop")).toBeDefined();
	expect(active.getByText("portikus_aaaa")).toBeDefined();
	expect(active.getByText("Read")).toBeDefined();
	expect(active.getByTestId("api-key-state").textContent).toBe("Active");
	expect(active.getByText("Never used")).toBeDefined();
	expect(active.getByRole("button", { name: "Renew" })).toBeDefined();
	expect(
		active.getByRole("button", { name: "Renew with a new secret…" }),
	).toBeDefined();
	// The buttons carry the key's name, so a screen reader knows which key.
	expect(
		active.getByRole("button", { name: "Revoke…" }).getAttribute("aria-describedby"),
	).toBe(`api-key-row-${ACTIVE.id}`);
});

test("a revoked key keeps no actions: it can never be renewed", async () => {
	renderWithQuery(<ApiKeysPane highlightId={null} needsSecondFactor={false} />);
	await screen.findByTestId("api-key-portikus_bbbb");
	const revoked = row("portikus_bbbb");
	expect(revoked.getByTestId("api-key-state").textContent).toBe("Revoked");
	expect(revoked.queryAllByRole("button")).toHaveLength(0);
	expect(revoked.getByTestId("api-key-expiry").textContent).toMatch(/^Revoked /);
});

test("an account with one period is told it, not offered a choice", async () => {
	renderWithQuery(<ApiKeysPane highlightId={null} needsSecondFactor={false} />);
	await openCreate();
	expect(screen.getByTestId("api-key-period-fixed").textContent).toContain("30 days");
	expect(screen.queryByRole("group", { name: "Expires after" })).toBeNull();
	// Read is the default access.
	expect(
		(screen.getByRole("radio", { name: /^Read/ }) as HTMLInputElement).checked,
	).toBe(true);
});

test("an account offered several periods chooses one, 30 days by default", async () => {
	periods = [7, 30, 90, null];
	renderWithQuery(<ApiKeysPane highlightId={null} needsSecondFactor={false} />);
	await openCreate();
	const group = screen.getByRole("group", { name: "Expires after" });
	const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
	expect(radios.map((radio) => radio.labels?.[0]?.textContent)).toEqual([
		"7 days",
		"30 days",
		"90 days",
		"Never",
	]);
	expect(radios[1]?.checked).toBe(true);
});

test("the default period follows what the API offers", () => {
	expect(defaultPeriod([7, 30, 90, null])).toBe(30);
	expect(defaultPeriod([30])).toBe(30);
	expect(defaultPeriod([7, 90])).toBe(7);
});

test("creating shows the secret once with a Claude Code command, then it is gone", async () => {
	renderWithQuery(<ApiKeysPane highlightId={null} needsSecondFactor={false} />);
	await openCreate();
	// A blank name is refused at the field.
	fireEvent.click(screen.getByTestId("api-key-create-submit"));
	expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
	fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Codex" } });
	fireEvent.click(screen.getByRole("radio", { name: /^Write/ }));
	fireEvent.click(screen.getByTestId("api-key-create-submit"));

	const secret = await screen.findByTestId("api-key-secret");
	await waitFor(() => expect(document.activeElement?.id).toBe("api-key-secret-title"));
	expect(within(secret).getByTestId("api-key-secret-value").textContent).toBe(SECRET);
	expect(secret.textContent).toContain("only time Portikus shows it");
	expect(within(secret).getByTestId("api-key-claude-command").textContent).toBe(
		`claude mcp add --transport http portikus ${window.location.origin}/mcp --header "Authorization: Bearer ${SECRET}"`,
	);
	expect(calls.find((call) => call.method === "POST")?.body).toEqual({
		name: "Codex",
		scope: "write",
		periodDays: 30,
	});

	fireEvent.click(screen.getByTestId("api-key-secret-done"));
	expect(screen.queryByTestId("api-key-secret")).toBeNull();
	expect(document.body.textContent).not.toContain(SECRET);
});

test("a Dex local-password account sends its code with the new key", async () => {
	periods = [7, 30, 90, null];
	renderWithQuery(<ApiKeysPane highlightId={null} needsSecondFactor />);
	await openCreate();
	fireEvent.change(screen.getByLabelText("Name"), { target: { value: "CI" } });
	fireEvent.click(screen.getByRole("radio", { name: "Never" }));
	// No code yet: refused at the code field, nothing sent.
	fireEvent.click(screen.getByTestId("api-key-create-submit"));
	const code = screen.getByLabelText("Two-step sign-in code");
	expect(code.getAttribute("aria-invalid")).toBe("true");
	expect(calls.some((call) => call.method === "POST")).toBe(false);

	// A wrong code is reported at the field.
	fireEvent.change(code, { target: { value: "000000" } });
	fireEvent.click(screen.getByTestId("api-key-create-submit"));
	await waitFor(() =>
		expect(
			screen.getByLabelText("Two-step sign-in code").getAttribute("aria-invalid"),
		).toBe("true"),
	);
	expect(document.body.textContent).toContain("That code is not right.");

	fireEvent.change(code, { target: { value: "123456" } });
	fireEvent.click(screen.getByTestId("api-key-create-submit"));
	await screen.findByTestId("api-key-secret");
	expect(calls.filter((call) => call.method === "POST").at(-1)?.body).toEqual({
		name: "CI",
		scope: "read",
		periodDays: null,
		code: "123456",
	});
});

test("a Dex local-password account with a passkey can use it instead of a code", async () => {
	renderWithQuery(<ApiKeysPane highlightId={null} needsSecondFactor />);
	await openCreate();
	fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Laptop" } });
	fireEvent.click(await screen.findByTestId("api-key-passkey"));
	await screen.findByTestId("api-key-secret");
	expect(calls.some((call) => call.url === "/me/api-keys/passkey/start")).toBe(true);
	const post = calls.filter(
		(call) => call.url === "/me/api-keys" && call.method === "POST",
	);
	expect(post.at(-1)?.body).toMatchObject({
		name: "Laptop",
		credential: { id: "cred" },
	});
});

test("Renew keeps the secret and announces the new expiry", async () => {
	renderWithQuery(<ApiKeysPane highlightId={null} needsSecondFactor={false} />);
	await screen.findByTestId("api-key-portikus_aaaa");
	fireEvent.click(row("portikus_aaaa").getByRole("button", { name: "Renew" }));
	await waitFor(() =>
		expect(screen.getByTestId("api-keys-status").textContent).toContain(
			"Claude on my laptop renewed. It now expires",
		),
	);
	expect(screen.queryByTestId("api-key-secret")).toBeNull();
});

test("Renew with a new secret confirms with the prefix and last use, then shows the new secret", async () => {
	renderWithQuery(<ApiKeysPane highlightId={null} needsSecondFactor={false} />);
	await screen.findByTestId("api-key-portikus_aaaa");
	fireEvent.click(
		row("portikus_aaaa").getByRole("button", { name: "Renew with a new secret…" }),
	);
	const confirm = await screen.findByTestId("api-key-rotate-confirm");
	expect(confirm.textContent).toContain("portikus_aaaa");
	expect(confirm.textContent).toContain("last used never");
	expect(confirm.textContent).toContain("old secret stops working");
	fireEvent.click(
		within(confirm).getByRole("button", { name: "Renew with a new secret" }),
	);
	const secret = await screen.findByTestId("api-key-secret");
	expect(within(secret).getByTestId("api-key-secret-value").textContent).toBe(
		"portikus_dddd_new",
	);
	expect(secret.textContent).toContain("The old secret has stopped working.");
});

test("Revoke confirms that it cannot be undone, and the key loses its actions", async () => {
	renderWithQuery(<ApiKeysPane highlightId={null} needsSecondFactor={false} />);
	await screen.findByTestId("api-key-portikus_aaaa");
	fireEvent.click(row("portikus_aaaa").getByRole("button", { name: "Revoke…" }));
	const confirm = await screen.findByTestId("api-key-revoke-confirm");
	expect(confirm.textContent).toContain("can never be renewed");
	expect(confirm.textContent).toContain("cannot be undone");
	fireEvent.click(within(confirm).getByRole("button", { name: "Revoke key" }));
	await waitFor(() =>
		expect(row("portikus_aaaa").getByTestId("api-key-state").textContent).toBe(
			"Revoked",
		),
	);
	expect(row("portikus_aaaa").queryAllByRole("button")).toHaveLength(0);
	expect(screen.getByTestId("api-keys-status").textContent).toBe(
		"Claude on my laptop revoked.",
	);
});

test("no keys yet says so", async () => {
	keys = [];
	renderWithQuery(<ApiKeysPane highlightId={null} needsSecondFactor={false} />);
	expect((await screen.findByTestId("api-keys-empty")).textContent).toBe(
		"You have no API keys yet.",
	);
});

function rotateCalls() {
	return calls.filter((call) => call.url.endsWith("/rotate"));
}

async function openRotate() {
	await screen.findByTestId("api-key-portikus_aaaa");
	fireEvent.click(
		row("portikus_aaaa").getByRole("button", { name: "Renew with a new secret…" }),
	);
	return screen.findByTestId("api-key-rotate-confirm");
}

test("an SSO account renews with a new secret without a second-factor step", async () => {
	renderWithQuery(<ApiKeysPane highlightId={null} needsSecondFactor={false} />);
	const confirm = await openRotate();
	expect(within(confirm).queryByLabelText("Two-step sign-in code")).toBeNull();
	fireEvent.click(
		within(confirm).getByRole("button", { name: "Renew with a new secret" }),
	);
	await screen.findByTestId("api-key-secret");
	expect(rotateCalls().map((call) => call.body)).toEqual([{}]);
});

test("a Dex local-password account proves a code to renew with a new secret", async () => {
	renderWithQuery(<ApiKeysPane highlightId={null} needsSecondFactor />);
	const confirm = await openRotate();
	const code = within(confirm).getByLabelText("Two-step sign-in code");
	// No code: refused at the field, nothing sent, and the confirm stays open.
	fireEvent.click(
		within(confirm).getByRole("button", { name: "Renew with a new secret" }),
	);
	expect(code.getAttribute("aria-invalid")).toBe("true");
	expect(rotateCalls()).toHaveLength(0);

	fireEvent.change(code, { target: { value: "000000" } });
	fireEvent.click(
		within(confirm).getByRole("button", { name: "Renew with a new secret" }),
	);
	await waitFor(() =>
		expect(within(confirm).getByText("That code is not right.")).toBeDefined(),
	);
	expect(screen.getByTestId("api-key-rotate-confirm")).toBe(confirm);

	fireEvent.change(code, { target: { value: "123456" } });
	fireEvent.click(
		within(confirm).getByRole("button", { name: "Renew with a new secret" }),
	);
	await screen.findByTestId("api-key-secret");
	expect(rotateCalls().at(-1)?.body).toEqual({ code: "123456" });
});

test("a Dex local-password account can renew with a new secret using its passkey", async () => {
	renderWithQuery(<ApiKeysPane highlightId={null} needsSecondFactor />);
	const confirm = await openRotate();
	fireEvent.click(await within(confirm).findByTestId("api-key-rotate-passkey"));
	await screen.findByTestId("api-key-secret");
	expect(calls.some((call) => call.url === "/me/api-keys/passkey/start")).toBe(true);
	expect(rotateCalls().at(-1)?.body).toMatchObject({ credential: { id: "cred" } });
});

test("the confirm says whether the new secret starts a fresh period", () => {
	expect(newPeriodText(30)).toBe("It starts a fresh 30-day period");
	expect(newPeriodText(null)).toBe("It still never expires");
});

test("the secret heading is described by the only-time-shown warning", async () => {
	renderWithQuery(<ApiKeysPane highlightId={null} needsSecondFactor={false} />);
	await openCreate();
	fireEvent.change(screen.getByLabelText("Name"), { target: { value: "CI" } });
	fireEvent.click(screen.getByTestId("api-key-create-submit"));
	const secret = await screen.findByTestId("api-key-secret");
	const heading = within(secret).getByRole("heading", { name: /Copy the secret for/ });
	expect(heading.getAttribute("aria-describedby")).toBeTruthy();
	expect(heading.hasAttribute("aria-describedby")).toBe(true);
	const warning = document.getElementById(
		heading.getAttribute("aria-describedby") ?? "",
	);
	expect(warning?.textContent).toContain("only time Portikus shows it");
});

test("focus lands on the new secret's heading after Renew with a new secret", async () => {
	renderWithQuery(<ApiKeysPane highlightId={null} needsSecondFactor={false} />);
	await screen.findByTestId("api-key-portikus_aaaa");
	fireEvent.click(
		row("portikus_aaaa").getByRole("button", { name: "Renew with a new secret…" }),
	);
	const confirm = await screen.findByTestId("api-key-rotate-confirm");
	fireEvent.click(
		within(confirm).getByRole("button", { name: "Renew with a new secret" }),
	);
	const secret = await screen.findByTestId("api-key-secret");
	const heading = within(secret).getByRole("heading", { name: /Copy the secret for/ });
	await waitFor(() => expect(document.activeElement).toBe(heading));
});

test("the pane is one named region; the list and create parts are not regions", async () => {
	renderWithQuery(<ApiKeysPane highlightId={null} needsSecondFactor={false} />);
	await screen.findByTestId("api-key-portikus_aaaa");
	const pane = screen.getByRole("region", { name: "API keys" });
	expect(within(pane).queryAllByRole("region")).toHaveLength(0);
	expect(within(pane).getByRole("heading", { name: "Your API keys" })).toBeDefined();
	expect(
		within(pane).getByRole("heading", { name: "Create an API key" }),
	).toBeDefined();
});

test("Enter in the renew code field submits it", async () => {
	renderWithQuery(<ApiKeysPane highlightId={null} needsSecondFactor />);
	const confirm = await openRotate();
	const code = within(confirm).getByLabelText("Two-step sign-in code");
	fireEvent.change(code, { target: { value: "123456" } });
	fireEvent.keyDown(code, { key: "Enter" });
	await screen.findByTestId("api-key-secret");
	expect(rotateCalls().at(-1)?.body).toEqual({ code: "123456" });
});
