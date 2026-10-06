/** Settings, Two-factor sign-in (SPEC.md section 24.13). */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../test-utils.js";
import { TwoFactorPane } from "./TwoFactorPane.js";

vi.mock("@simplewebauthn/browser", () => ({
	browserSupportsWebAuthn: () => true,
	startRegistration: vi.fn(async () => ({
		id: "cred",
		rawId: "cred",
		type: "public-key",
	})),
	startAuthentication: vi.fn(),
}));

const APP = {
	id: "11111111-1111-4111-8111-111111111111",
	kind: "totp",
	label: "Phone",
	createdAt: "2026-09-01T10:00:00.000Z",
	lastUsedAt: null,
};
const KEY = {
	id: "22222222-2222-4222-8222-222222222222",
	kind: "webauthn",
	label: "Laptop",
	createdAt: "2026-09-02T10:00:00.000Z",
	lastUsedAt: "2026-09-03T10:00:00.000Z",
};
const CODES = ["AAAA-BBBB-CCCC-DDDD", "EEEE-FFFF-GGGG-HHHH"];

let factors: object[];
let calls: { url: string; method: string; body: unknown }[];

beforeEach(() => {
	factors = [APP];
	calls = [];
	stubFetch((url, init) => {
		const method = init?.method ?? "GET";
		calls.push({
			url,
			method,
			body: init?.body ? JSON.parse(String(init.body)) : null,
		});
		if (url === "/me/second-factor")
			return json(200, { factors, recoveryCodesLeft: 7 });
		if (url === "/me/second-factor/recovery-codes")
			return json(200, { recoveryCodes: CODES });
		if (url === "/me/second-factor/webauthn/start")
			return json(200, { challenge: "abc", rp: { id: "x", name: "Portikus" } });
		if (url === "/me/second-factor/webauthn") {
			factors = [APP, KEY];
			return json(200, { recoveryCodes: CODES });
		}
		if (url === `/me/second-factor/${APP.id}` && method === "DELETE")
			return json(409, {
				code: "LAST_SECOND_FACTOR",
				message: "Add another way to sign in before you remove this one.",
			});
		if (url === `/me/second-factor/${APP.id}` && method === "PATCH") {
			factors = [{ ...APP, label: "Work phone" }];
			return new Response(null, { status: 204 });
		}
		throw new Error(`unexpected request to ${method} ${url}`);
	});
});

afterEach(() => vi.unstubAllGlobals());

test("each factor shows its name, kind, when it was added and last used", async () => {
	factors = [APP, KEY];
	renderWithQuery(<TwoFactorPane highlightId={null} />);
	const app = await screen.findByTestId("factor-totp");
	expect(app.textContent).toContain("Phone");
	expect(app.textContent).toContain("Authenticator app. Added");
	expect(app.textContent).toContain("Never used.");
	const key = screen.getByTestId("factor-webauthn");
	expect(key.textContent).toContain("Passkey. Added");
	expect(key.textContent).toContain("Last used");
	expect(screen.getByTestId("recovery-codes-left").textContent).toContain(
		"7 unused recovery codes left.",
	);
});

test("removing the last factor is refused, and the reason is shown", async () => {
	renderWithQuery(<TwoFactorPane highlightId={null} />);
	fireEvent.click(await screen.findByRole("button", { name: "Remove Phone" }));
	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toBe(
		"Add another way to sign in before you remove this one.",
	);
	expect(screen.getByTestId("factor-totp")).toBeTruthy();
});

test("a factor is renamed in place", async () => {
	renderWithQuery(<TwoFactorPane highlightId={null} />);
	fireEvent.click(await screen.findByRole("button", { name: "Rename Phone" }));
	const field = screen.getByLabelText("Name");
	expect(document.activeElement).toBe(field);
	fireEvent.change(field, { target: { value: "Work phone" } });
	fireEvent.click(screen.getByRole("button", { name: "Save name" }));
	expect(await screen.findByText("Work phone")).toBeTruthy();
	expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
		label: "Work phone",
	});
	await waitFor(() =>
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Rename Work phone" }),
		),
	);
});

test("an empty name is refused on the field", async () => {
	renderWithQuery(<TwoFactorPane highlightId={null} />);
	fireEvent.click(await screen.findByRole("button", { name: "Rename Phone" }));
	fireEvent.change(screen.getByLabelText("Name"), { target: { value: " " } });
	fireEvent.click(screen.getByRole("button", { name: "Save name" }));
	await waitFor(() =>
		expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBe("true"),
	);
	expect(calls.some((c) => c.method === "PATCH")).toBe(false);
});

test("new recovery codes are shown once, with the heading focused", async () => {
	renderWithQuery(<TwoFactorPane highlightId={null} />);
	fireEvent.click(
		await screen.findByRole("button", { name: "Make new recovery codes" }),
	);
	const heading = await screen.findByRole("heading", {
		name: "Your new recovery codes",
	});
	expect(document.activeElement).toBe(heading);
	const list = screen.getByRole("list", { name: "Recovery codes" });
	expect(within(list).getByText(CODES[0] as string)).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "I have saved them, continue" }));
	expect(screen.queryByRole("list", { name: "Recovery codes" })).toBeNull();
});

test("a passkey is added and the list refreshes", async () => {
	renderWithQuery(<TwoFactorPane highlightId={null} />);
	fireEvent.click(await screen.findByRole("button", { name: "Add a passkey" }));
	expect(
		await screen.findByRole("heading", { name: "Your new recovery codes" }),
	).toBeTruthy();
	expect(await screen.findByTestId("factor-webauthn")).toBeTruthy();
	expect(calls.find((c) => c.url === "/me/second-factor/webauthn")?.body).toMatchObject(
		{
			credential: { id: "cred" },
		},
	);
});

test("adding an authenticator app opens the setup steps, and Cancel closes them, keeping focus", async () => {
	stubFetch((url) => {
		if (url === "/me/second-factor")
			return json(200, { factors, recoveryCodesLeft: 7 });
		if (url === "/me/second-factor/totp/start")
			return json(200, {
				token: "t",
				secret: "JBSWY3DPEHPK3PXP",
				uri: "otpauth://totp/x",
				qrCode: "data:image/svg+xml;base64,PHN2Zy8+",
			});
		throw new Error(`unexpected request to ${url}`);
	});
	renderWithQuery(<TwoFactorPane highlightId={null} />);
	const add = await screen.findByRole("button", { name: "Add an authenticator app" });
	add.focus();
	fireEvent.click(add);
	// The button goes away; the section heading holds focus instead of the page.
	expect(document.activeElement).toBe(
		screen.getByRole("heading", { name: "Add a sign-in method" }),
	);
	expect(await screen.findByAltText("QR code for your authenticator app")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
	expect(screen.queryByAltText("QR code for your authenticator app")).toBeNull();
	expect(document.activeElement).toBe(
		screen.getByRole("button", { name: "Add an authenticator app" }),
	);
});
