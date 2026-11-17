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
	const toggle = await screen.findByRole("switch");
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
	const toggle = await screen.findByRole("switch");
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
	fireEvent.click(await screen.findByRole("switch"));
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
