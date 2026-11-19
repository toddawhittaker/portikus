import { AI_NOTICE_VERSION, type AiSettingsView } from "@portikus/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../../test-utils.js";
import { AiTab } from "./AiTab.js";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const BASE: AiSettingsView = {
	enabled: false,
	providerKind: "openai-compatible",
	baseUrl: null,
	model: null,
	keySet: false,
	keyHint: null,
	monthlyTokenCap: 5_000_000,
	conversationTokenBudget: 200_000,
	noticeVersion: null,
	noticeAcceptedAt: null,
	noticeAcceptedBy: null,
	usedThisMonth: 1_000_000,
	priceSources: [],
	triageEnabled: false,
	triageDailyLimit: 5,
	triageForward: false,
	hostListed: false,
};

const READY: AiSettingsView = {
	...BASE,
	baseUrl: "https://api.openai.com/v1",
	model: "gpt-x",
	keySet: true,
	keyHint: "WXYZ",
	noticeVersion: AI_NOTICE_VERSION,
	noticeAcceptedAt: "2026-11-01T10:00:00.000Z",
	noticeAcceptedBy: "Carol Admin",
	hostListed: true,
};

type Sent = { url: string; method: string; body: unknown }[];

function serve(view: AiSettingsView, extra?: (url: string) => Response | null) {
	let current = view;
	const sent: Sent = [];
	stubFetch((url, init) => {
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		sent.push({ url, method, body });
		const answer = extra?.(url);
		if (answer) return answer;
		if (url === "/admin/ai/models") return json(200, { models: null });
		if (url === "/admin/ai/notice") {
			current = {
				...current,
				noticeVersion: body.noticeVersion,
				noticeAcceptedAt: "2026-11-15T09:00:00.000Z",
				noticeAcceptedBy: "Carol Admin",
			};
		} else if (url === "/admin/ai" && method === "PUT") {
			const { key, clearKey, addProxyHost: _, ...rest } = body;
			current = { ...current, ...rest };
			if (key) current = { ...current, keySet: true, keyHint: key.slice(-4) };
			if (clearKey) current = { ...current, keySet: false, keyHint: null };
		}
		return json(200, current);
	});
	return sent;
}

test("the notice shows in full until accepted, then who accepted it", async () => {
	const sent = serve(BASE);
	renderWithQuery(<AiTab />);
	const notice = await screen.findByTestId("ai-notice");
	expect(within(notice).getByText(/never sent/)).toBeTruthy();
	expect(within(notice).getByText(/30 days/)).toBeTruthy();
	fireEvent.click(within(notice).getByRole("button", { name: "I have read this" }));
	await screen.findByTestId("ai-notice-accepted");
	expect(screen.getByTestId("ai-notice-accepted").textContent).toMatch(/Carol Admin/);
	expect(sent.find((r) => r.url === "/admin/ai/notice")?.body).toEqual({
		noticeVersion: AI_NOTICE_VERSION,
	});
	// The notice is still readable, behind a disclosure.
	expect(screen.getByText("Read the notice again")).toBeTruthy();
});

test("the switch is locked with its reason until the notice and key are in place", async () => {
	const sent = serve(BASE);
	renderWithQuery(<AiTab />);
	const toggle = await screen.findByRole("switch", { name: /Turn on the assistant/ });
	expect(toggle.getAttribute("aria-disabled")).toBe("true");
	expect(screen.getByTestId("ai-switch-reason").textContent).toMatch(
		/notice and set a key/,
	);
	fireEvent.click(toggle);
	expect(sent.some((r) => r.method === "PUT")).toBe(false);
});

test("a ready site turns the assistant on", async () => {
	const sent = serve(READY);
	renderWithQuery(<AiTab />);
	const toggle = await screen.findByRole("switch", { name: /Turn on the assistant/ });
	expect(toggle.getAttribute("aria-disabled")).toBe(null);
	fireEvent.click(toggle);
	await waitFor(() =>
		expect(sent.find((r) => r.method === "PUT")?.body).toEqual({ enabled: true }),
	);
});

test("saving the provider sends the key once and shows only its hint, with the proxy offer", async () => {
	const sent = serve(BASE);
	renderWithQuery(<AiTab />);
	const provider = await screen.findByTestId("ai-provider");
	expect(within(provider).getByTestId("ai-key-state").textContent).toBe("Not set");
	expect(within(provider).getByLabelText<HTMLInputElement>("Base address").value).toBe(
		"https://api.openai.com/v1",
	);
	expect(within(provider).getByTestId("ai-proxy-offer").textContent).toMatch(
		/reach api\.openai\.com on port 443/,
	);
	fireEvent.change(within(provider).getByLabelText("Model"), {
		target: { value: "gpt-x" },
	});
	fireEvent.change(within(provider).getByLabelText("Key"), {
		target: { value: "sk-secret-ABCD" },
	});
	fireEvent.click(within(provider).getByRole("button", { name: "Save provider" }));
	await waitFor(() =>
		expect(screen.getByTestId("ai-key-state").textContent).toBe("Set, ends in ABCD"),
	);
	expect(sent.find((r) => r.method === "PUT")?.body).toEqual({
		providerKind: "openai-compatible",
		baseUrl: "https://api.openai.com/v1",
		model: "gpt-x",
		key: "sk-secret-ABCD",
		addProxyHost: true,
	});
	expect(screen.queryByDisplayValue("sk-secret-ABCD")).toBe(null);
});

test("a bad address and an empty model are tied to their fields", async () => {
	const sent = serve(BASE);
	renderWithQuery(<AiTab />);
	const provider = await screen.findByTestId("ai-provider");
	const address = within(provider).getByLabelText("Base address");
	fireEvent.change(address, { target: { value: "http://10.0.0.1" } });
	fireEvent.click(within(provider).getByRole("button", { name: "Save provider" }));
	await waitFor(() => expect(address.getAttribute("aria-invalid")).toBe("true"));
	expect(within(provider).getByLabelText("Model").getAttribute("aria-invalid")).toBe(
		"true",
	);
	expect(document.activeElement).toBe(address);
	expect(sent.some((r) => r.method === "PUT")).toBe(false);
});

test("choosing Anthropic fills its address; a listed host is not offered", async () => {
	serve(READY, (url) =>
		url === "/admin/ai/models" ? json(200, { models: ["gpt-x", "gpt-y"] }) : null,
	);
	renderWithQuery(<AiTab />);
	const provider = await screen.findByTestId("ai-provider");
	expect(within(provider).queryByTestId("ai-proxy-offer")).toBe(null);
	expect(within(provider).getByTestId("ai-key-state").textContent).toBe(
		"Set, ends in WXYZ",
	);
	// The model list from the provider replaces the free-text box.
	await waitFor(() =>
		expect(within(provider).getByRole("combobox", { name: "Model" })).toBeTruthy(),
	);
});

test("Clear removes the key", async () => {
	const sent = serve(READY);
	renderWithQuery(<AiTab />);
	fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
	await waitFor(() =>
		expect(screen.getByTestId("ai-key-state").textContent).toBe("Not set"),
	);
	expect(sent.find((r) => r.method === "PUT")?.body).toEqual({ clearKey: true });
});

test("limits save as numbers and a bad one is refused at its field", async () => {
	const sent = serve(READY);
	renderWithQuery(<AiTab />);
	const limits = await screen.findByTestId("ai-limits");
	expect(within(limits).getByText(/1,000,000 tokens of 5,000,000 tokens/)).toBeTruthy();
	const cap = within(limits).getByLabelText("Monthly token cap");
	fireEvent.change(cap, { target: { value: "0" } });
	fireEvent.click(within(limits).getByRole("button", { name: "Save limits" }));
	await waitFor(() => expect(cap.getAttribute("aria-invalid")).toBe("true"));
	fireEvent.change(cap, { target: { value: "1,000,000" } });
	fireEvent.change(within(limits).getByLabelText("Budget for each conversation"), {
		target: { value: "50000" },
	});
	fireEvent.click(within(limits).getByRole("button", { name: "Save limits" }));
	await waitFor(() =>
		expect(sent.find((r) => r.method === "PUT")?.body).toEqual({
			monthlyTokenCap: 1_000_000,
			conversationTokenBudget: 50_000,
		}),
	);
});

test("the test shows the stages reached and a plain message, never the reply", async () => {
	serve(READY, (url) =>
		url === "/admin/ai/test"
			? json(200, {
					ok: false,
					stage: "reply",
					errorCode: "no-tool-call",
					model: "gpt-x",
					usage: null,
				})
			: null,
	);
	renderWithQuery(<AiTab />);
	fireEvent.click(await screen.findByRole("button", { name: "Test" }));
	const message = await screen.findByTestId("ai-test-message");
	expect(message.textContent).toMatch(/did not call the tool/);
	expect(screen.getByTestId("ai-test-stage-reply").dataset.state).toBe("done");
	expect(screen.getByTestId("ai-test-stage-tool-call").dataset.state).toBe("failed");
	expect(screen.getByTestId("ai-test-stage-tool-result").dataset.state).toBe(
		"not-reached",
	);
});

test("a refused switch shows the API's reason", async () => {
	stubFetch((url, init) => {
		if (url === "/admin/ai/models") return json(200, { models: null });
		if (init?.method === "PUT")
			return json(409, { code: "AI_KEY_REQUIRED", message: "Set a key first." });
		return json(200, READY);
	});
	renderWithQuery(<AiTab />);
	fireEvent.click(await screen.findByRole("switch", { name: /Turn on the assistant/ }));
	expect((await screen.findByRole("alert")).textContent).toBe("Set a key first.");
});

test("accepting the notice moves focus to the Provider heading, since its button goes away", async () => {
	serve(BASE);
	renderWithQuery(<AiTab />);
	const notice = await screen.findByTestId("ai-notice");
	const accept = within(notice).getByRole("button", { name: "I have read this" });
	accept.focus();
	fireEvent.click(accept);
	await screen.findByTestId("ai-notice-accepted");
	await waitFor(() =>
		expect(document.activeElement).toBe(
			screen.getByRole("heading", { name: "Provider" }),
		),
	);
});

test("Replace moves focus into the new key field", async () => {
	serve(READY);
	renderWithQuery(<AiTab />);
	fireEvent.click(await screen.findByTestId("ai-key-replace"));
	await waitFor(() =>
		expect(document.activeElement).toBe(screen.getByLabelText("New key")),
	);
});

test("Clear moves focus to the key's status, since its button goes away", async () => {
	serve(READY);
	renderWithQuery(<AiTab />);
	const clear = await screen.findByTestId("ai-key-clear");
	clear.focus();
	fireEvent.click(clear);
	await waitFor(() => expect(screen.queryByTestId("ai-key-clear")).toBeNull());
	expect(document.activeElement).toBe(screen.getByTestId("ai-key-state"));
});

test("a listed model left unchosen shows its error on the Select", async () => {
	serve({ ...READY, model: null }, (url) =>
		url === "/admin/ai/models" ? json(200, { models: ["gpt-a", "gpt-b"] }) : null,
	);
	renderWithQuery(<AiTab />);
	const trigger = await screen.findByRole("combobox", { name: /Model/ });
	fireEvent.click(screen.getByTestId("ai-provider-save"));
	await waitFor(() => expect(trigger.getAttribute("aria-invalid")).toBe("true"));
	expect(document.getElementById("ai-model-err")?.textContent).toBe(
		"Give the model's name.",
	);
	expect(trigger.getAttribute("aria-describedby")).toContain("ai-model-err");
	expect(document.activeElement).toBe(trigger);
});

test("a notice accepted at an older version must be accepted again", async () => {
	const sent = serve({ ...READY, noticeVersion: AI_NOTICE_VERSION - 1 });
	renderWithQuery(<AiTab />);
	const notice = await screen.findByTestId("ai-notice");
	// The full notice is back, with its alert explanation paragraph.
	expect(within(notice).getByTestId("ai-notice-alerts").textContent).toMatch(
		/without anyone asking.*alert, the latest health figures and a few recent error lines.*Nothing else is sent/,
	);
	expect(
		screen
			.getByRole("switch", { name: /Turn on the assistant/ })
			.getAttribute("aria-disabled"),
	).toBe("true");
	fireEvent.click(within(notice).getByRole("button", { name: "I have read this" }));
	await screen.findByTestId("ai-notice-accepted");
	expect(sent.find((r) => r.url === "/admin/ai/notice")?.body).toEqual({
		noticeVersion: AI_NOTICE_VERSION,
	});
});

test("alert explanations are off by default and hide the limit until turned on", async () => {
	const sent = serve(READY);
	renderWithQuery(<AiTab />);
	const group = await screen.findByTestId("ai-triage");
	const explain = within(group).getByRole("switch", { name: "Explain alerts" });
	const forward = within(group).getByRole("switch", {
		name: "Add explanations to email and Pushover alerts",
	});
	expect((explain as HTMLInputElement).checked).toBe(false);
	expect((forward as HTMLInputElement).checked).toBe(false);
	expect(within(group).queryByLabelText("Most explanations a day")).toBeNull();
	fireEvent.click(explain);
	await waitFor(() =>
		expect(
			within(group).getByLabelText<HTMLInputElement>("Most explanations a day").value,
		).toBe("5"),
	);
	expect(sent.find((r) => r.method === "PUT")?.body).toEqual({ triageEnabled: true });
	fireEvent.click(forward);
	await waitFor(() =>
		expect(sent.filter((r) => r.method === "PUT").at(-1)?.body).toEqual({
			triageForward: true,
		}),
	);
});

test("the daily limit takes 0 to 100 and refuses the rest at its field", async () => {
	const sent = serve({ ...READY, triageEnabled: true });
	renderWithQuery(<AiTab />);
	const group = await screen.findByTestId("ai-triage");
	const limit = within(group).getByLabelText<HTMLInputElement>(
		"Most explanations a day",
	);
	const save = within(group).getByRole("button", { name: "Save daily limit" });
	for (const bad of ["101", "-1", "2.5", "five", ""]) {
		fireEvent.change(limit, { target: { value: bad } });
		fireEvent.click(save);
		await waitFor(() => expect(limit.getAttribute("aria-invalid")).toBe("true"));
		expect(document.activeElement).toBe(limit);
	}
	expect(sent.some((r) => r.method === "PUT")).toBe(false);
	fireEvent.change(limit, { target: { value: "0" } });
	fireEvent.click(save);
	await waitFor(() =>
		expect(sent.find((r) => r.method === "PUT")?.body).toEqual({ triageDailyLimit: 0 }),
	);
	await waitFor(() => expect(limit.value).toBe("0"));
	fireEvent.change(limit, { target: { value: "100" } });
	fireEvent.click(save);
	await waitFor(() =>
		expect(sent.filter((r) => r.method === "PUT").at(-1)?.body).toEqual({
			triageDailyLimit: 100,
		}),
	);
});

test("saving the daily limit by Enter keeps focus on the field (WCAG 2.4.3)", async () => {
	const sent = serve({ ...READY, triageEnabled: true });
	renderWithQuery(<AiTab />);
	const group = await screen.findByTestId("ai-triage");
	const limit = within(group).getByLabelText<HTMLInputElement>(
		"Most explanations a day",
	);
	limit.focus();
	fireEvent.change(limit, { target: { value: "12" } });
	fireEvent.submit(limit.closest("form") as HTMLFormElement);
	await waitFor(() =>
		expect(sent.find((r) => r.method === "PUT")?.body).toEqual({
			triageDailyLimit: 12,
		}),
	);
	// The saved value comes back; the same field stays in the page, still focused.
	await waitFor(() => expect(sent.filter((r) => r.url === "/admin/ai").length).toBe(2));
	expect(limit.isConnected).toBe(true);
	expect(document.activeElement).toBe(limit);
	expect(limit.value).toBe("12");
});

test("saving the daily limit with the button keeps focus on the button", async () => {
	const sent = serve({ ...READY, triageEnabled: true });
	renderWithQuery(<AiTab />);
	const group = await screen.findByTestId("ai-triage");
	const limit = within(group).getByLabelText<HTMLInputElement>(
		"Most explanations a day",
	);
	const save = within(group).getByRole("button", { name: "Save daily limit" });
	fireEvent.change(limit, { target: { value: "7" } });
	save.focus();
	fireEvent.click(save);
	await waitFor(() =>
		expect(sent.find((r) => r.method === "PUT")?.body).toEqual({ triageDailyLimit: 7 }),
	);
	await waitFor(() => expect(save.getAttribute("aria-busy")).toBe(null));
	expect(save.isConnected).toBe(true);
	expect(document.activeElement).toBe(save);
});

test("a limit saved elsewhere replaces the field's text in place", async () => {
	serve({ ...READY, triageEnabled: true });
	const queryClient = renderWithQuery(<AiTab />);
	const group = await screen.findByTestId("ai-triage");
	const limit = within(group).getByLabelText<HTMLInputElement>(
		"Most explanations a day",
	);
	expect(limit.value).toBe("5");
	queryClient.setQueryData(["admin", "ai"], {
		...READY,
		triageEnabled: true,
		triageDailyLimit: 9,
	});
	await waitFor(() => expect(limit.value).toBe("9"));
});

test("a refused alert setting shows the API's reason", async () => {
	stubFetch((url, init) => {
		if (url === "/admin/ai/models") return json(200, { models: null });
		if (init?.method === "PUT")
			return json(400, { code: "VALIDATION_FAILED", message: "Not allowed." });
		return json(200, READY);
	});
	renderWithQuery(<AiTab />);
	const group = await screen.findByTestId("ai-triage");
	fireEvent.click(within(group).getByRole("switch", { name: "Explain alerts" }));
	expect((await within(group).findByRole("alert")).textContent).toBe("Not allowed.");
});

test("a test site alert reports its title in the group's live status", async () => {
	const sent = serve(READY, (url) =>
		url === "/admin/alerts/test-site-alert"
			? json(200, { title: "Test site alert sent at 14:03:27.400 UTC" })
			: null,
	);
	renderWithQuery(<AiTab />);
	const group = await screen.findByTestId("ai-triage");
	const button = within(group).getByRole("button", { name: "Send a test site alert" });
	expect(button.getAttribute("aria-describedby")).toBeTruthy();
	expect(
		document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent,
	).toMatch(
		/notifications list.*explained if Explain alerts is on.*alert channels.*Most explanations a day/s,
	);
	const status = within(group).getByTestId("ai-triage-test-result");
	expect(status.getAttribute("role")).toBe("status");
	expect(status.textContent).toBe("");
	fireEvent.click(button);
	await waitFor(() =>
		expect(status.textContent).toBe(
			"Sent. Look for “Test site alert sent at 14:03:27.400 UTC” in the notifications list.",
		),
	);
	expect(sent.filter((r) => r.url === "/admin/alerts/test-site-alert")).toEqual([
		{ url: "/admin/alerts/test-site-alert", method: "POST", body: {} },
	]);
});

test("a refused test site alert says to wait, and another failure gives the API's reason", async () => {
	let answer = json(429, { code: "RATE_LIMITED", message: "Too many requests." });
	serve(READY, (url) => (url === "/admin/alerts/test-site-alert" ? answer : null));
	renderWithQuery(<AiTab />);
	const group = await screen.findByTestId("ai-triage");
	const button = within(group).getByRole("button", { name: "Send a test site alert" });
	const status = within(group).getByTestId("ai-triage-test-result");
	fireEvent.click(button);
	await waitFor(() =>
		expect(status.textContent).toBe(
			"Not sent: up to 3 test site alerts an hour. Try again later.",
		),
	);
	answer = json(403, { code: "FORBIDDEN", message: "Administrators only." });
	fireEvent.click(button);
	await waitFor(() =>
		expect(status.textContent).toBe("Not sent: Administrators only."),
	);
});
