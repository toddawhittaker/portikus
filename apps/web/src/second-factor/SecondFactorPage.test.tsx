/** Two-step sign-in pages (SPEC.md section 24.13). */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER } from "../test-utils.js";
import { gatePath } from "../useMe.js";

vi.mock("@simplewebauthn/browser", () => ({
	browserSupportsWebAuthn: () => true,
	startRegistration: vi.fn(async () => ({
		id: "new",
		rawId: "new",
		type: "public-key",
	})),
	startAuthentication: vi.fn(async () => ({
		id: "old",
		rawId: "old",
		type: "public-key",
	})),
}));

afterEach(() => vi.unstubAllGlobals());

test("the setup page offers a passkey, which shows the recovery codes", async () => {
	let enrolled = false;
	stubFetch((url) => {
		if (url === "/auth/me")
			return json(200, { ...LOCAL, secondFactor: enrolled ? null : "enrol" });
		if (url === "/me/second-factor/totp/start") return json(200, START);
		if (url === "/me/second-factor/webauthn/start")
			return json(200, { challenge: "c" });
		if (url === "/me/second-factor/webauthn") {
			enrolled = true;
			return json(200, { recoveryCodes: ["AAAA-BBBB-CCCC-DDDD"] });
		}
		return json(403, GATED);
	});
	renderApp("/second-factor");
	fireEvent.click(await screen.findByRole("button", { name: "Use a passkey" }));
	expect(
		await screen.findByRole("heading", { name: "Save your recovery codes" }),
	).toBeTruthy();
});

test("the code page offers a passkey only when the account has one", async () => {
	let verified = false;
	const fetch = stubFetch((url) => {
		if (url === "/auth/me")
			return json(200, { ...LOCAL, secondFactor: verified ? null : "verify" });
		if (url === "/me/second-factor")
			return json(200, {
				factors: [
					{
						id: "22222222-2222-4222-8222-222222222222",
						kind: "webauthn",
						label: "Laptop",
						createdAt: "2026-09-02T10:00:00.000Z",
						lastUsedAt: null,
					},
				],
				recoveryCodesLeft: 10,
			});
		if (url === "/me/second-factor/webauthn/verify/start")
			return json(200, { challenge: "c" });
		if (url === "/me/second-factor/webauthn/verify") {
			verified = true;
			return new Response(null, { status: 204 });
		}
		return json(404, { code: "NOT_FOUND", message: "no" });
	});
	const { router } = renderApp("/second-factor");
	fireEvent.click(await screen.findByRole("button", { name: "Use a passkey" }));
	await waitFor(() =>
		expect(router.state.location.pathname).not.toBe("/second-factor"),
	);
	expect(
		fetch.mock.calls.find(([url]) => url === "/me/second-factor/webauthn/verify")?.[1]
			?.body,
	).toBe(
		JSON.stringify({ credential: { id: "old", rawId: "old", type: "public-key" } }),
	);
});

test("a cancelled passkey prompt is announced in the user's terms", async () => {
	const { startAuthentication } = await import("@simplewebauthn/browser");
	vi.mocked(startAuthentication).mockRejectedValueOnce(new Error("NotAllowedError"));
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, { ...LOCAL, secondFactor: "verify" });
		if (url === "/me/second-factor")
			return json(200, {
				factors: [
					{
						id: "22222222-2222-4222-8222-222222222222",
						kind: "webauthn",
						label: "Laptop",
						createdAt: "2026-09-02T10:00:00.000Z",
						lastUsedAt: null,
					},
				],
				recoveryCodesLeft: 10,
			});
		if (url === "/me/second-factor/webauthn/verify/start")
			return json(200, { challenge: "c" });
		return json(403, GATED);
	});
	renderApp("/second-factor");
	fireEvent.click(await screen.findByRole("button", { name: "Use a passkey" }));
	expect((await screen.findByRole("alert")).textContent).toBe(
		"The passkey was not used. Try again, or choose another way.",
	);
});

const LOCAL = { ...USER, localPassword: true };
const START = {
	token: "123.v1:abc",
	secret: "JBSWY3DPEHPK3PXP",
	uri: "otpauth://totp/x",
	qrCode: "data:image/svg+xml;base64,PHN2Zy8+",
};
const GATED = { code: "SECOND_FACTOR_REQUIRED", message: "no" };

function authed(user: object) {
	return { status: "authenticated" as const, user: { ...LOCAL, ...user } };
}

test("gate order: verify, then password, then enrol, then acceptable use", () => {
	expect(gatePath(authed({ secondFactor: "verify", mustChangePassword: true }))).toBe(
		"/second-factor",
	);
	expect(gatePath(authed({ secondFactor: "enrol", mustChangePassword: true }))).toBe(
		"/change-password",
	);
	expect(gatePath(authed({ secondFactor: "enrol", mustAcceptUse: true }))).toBe(
		"/second-factor",
	);
	expect(gatePath(authed({ mustAcceptUse: true }))).toBe("/acceptable-use");
});

test("an account without a factor is sent to set one up, with the QR code and key", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, { ...LOCAL, secondFactor: "enrol" });
		if (url === "/me/second-factor/totp/start") return json(200, START);
		return json(403, GATED);
	});
	const { router } = renderApp("/");
	await waitFor(() => expect(router.state.location.pathname).toBe("/second-factor"));
	const heading = await screen.findByRole("heading", {
		name: "Set up two-step sign-in",
	});
	await waitFor(() => expect(document.activeElement).toBe(heading));
	expect(await screen.findByAltText("QR code for your authenticator app")).toBeTruthy();
	expect(screen.getByTestId("totp-secret").textContent).toBe(START.secret);
	const field = screen.getByLabelText("Code from your app");
	expect(field.getAttribute("autocomplete")).toBe("one-time-code");
	expect(field.getAttribute("inputmode")).toBe("numeric");
});

test("a short code is refused on the field before anything is sent", async () => {
	const fetch = stubFetch((url) => {
		if (url === "/auth/me") return json(200, { ...LOCAL, secondFactor: "enrol" });
		if (url === "/me/second-factor/totp/start") return json(200, START);
		return json(403, GATED);
	});
	renderApp("/second-factor");
	const field = await screen.findByLabelText("Code from your app");
	fireEvent.change(field, { target: { value: "12" } });
	fireEvent.click(screen.getByRole("button", { name: "Turn on two-step sign-in" }));
	await waitFor(() => expect(field.getAttribute("aria-invalid")).toBe("true"));
	expect(document.activeElement).toBe(field);
	expect(fetch.mock.calls.some(([url]) => url === "/me/second-factor/totp")).toBe(
		false,
	);
});

test("after enrolment the recovery codes are shown before going on", async () => {
	let enrolled = false;
	stubFetch((url) => {
		if (url === "/auth/me")
			return json(200, { ...LOCAL, secondFactor: enrolled ? null : "enrol" });
		if (url === "/me/second-factor/totp/start") return json(200, START);
		if (url === "/me/second-factor/totp") {
			enrolled = true;
			return json(200, {
				recoveryCodes: ["AAAA-BBBB-CCCC-DDDD", "EEEE-FFFF-GGGG-HHHH"],
			});
		}
		return json(404, { code: "NOT_FOUND", message: "no" });
	});
	const { router } = renderApp("/second-factor");
	fireEvent.change(await screen.findByLabelText("Code from your app"), {
		target: { value: "123456" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Turn on two-step sign-in" }));
	expect(
		await screen.findByRole("heading", { name: "Save your recovery codes" }),
	).toBeTruthy();
	expect(screen.getByText("AAAA-BBBB-CCCC-DDDD")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "I have saved them, continue" }));
	await waitFor(() =>
		expect(router.state.location.pathname).not.toBe("/second-factor"),
	);
});

test("an enrolled account enters a code; a wrong one is announced on the field", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, { ...LOCAL, secondFactor: "verify" });
		if (url === "/me/second-factor/verify")
			return json(403, { code: "WRONG_CODE", message: "That code is not right." });
		return json(403, GATED);
	});
	renderApp("/");
	const field = await screen.findByLabelText("Code from your app");
	fireEvent.change(field, { target: { value: "000000" } });
	fireEvent.click(screen.getByRole("button", { name: "Continue" }));
	await waitFor(() => expect(field.getAttribute("aria-invalid")).toBe("true"));
	expect(field.getAttribute("aria-describedby")).toBeTruthy();
	expect(await screen.findByText("That code is not right.")).toBeTruthy();
	expect(document.activeElement).toBe(field);
});

test("a recovery code can be used instead", async () => {
	const fetch = stubFetch((url) => {
		if (url === "/auth/me") return json(200, { ...LOCAL, secondFactor: "verify" });
		if (url === "/me/second-factor/verify") return new Response(null, { status: 204 });
		return json(403, GATED);
	});
	renderApp("/second-factor");
	fireEvent.click(await screen.findByRole("button", { name: "Use a recovery code" }));
	const field = screen.getByLabelText("Recovery code");
	expect(document.activeElement).toBe(field);
	fireEvent.change(field, { target: { value: "aaaa-bbbb-cccc-dddd" } });
	fireEvent.click(screen.getByRole("button", { name: "Continue" }));
	await waitFor(() =>
		expect(
			fetch.mock.calls.find(([url]) => url === "/me/second-factor/verify")?.[1]?.body,
		).toBe(JSON.stringify({ code: "aaaa-bbbb-cccc-dddd" })),
	);
});
