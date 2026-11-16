import {
	type AdminModelPrice,
	AI_NOTICE_VERSION,
	type AiSettingsView,
	type PriceProposal,
	type PriceRun,
} from "@portikus/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../../test-utils.js";
import { PricingTab } from "./PricingTab.js";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const AI: AiSettingsView = {
	enabled: true,
	providerKind: "openai-compatible",
	baseUrl: "https://api.openai.com/v1",
	model: "gpt-x",
	keySet: true,
	keyHint: "WXYZ",
	monthlyTokenCap: 5_000_000,
	conversationTokenBudget: 200_000,
	noticeVersion: AI_NOTICE_VERSION,
	noticeAcceptedAt: "2026-11-01T10:00:00.000Z",
	noticeAcceptedBy: "Carol Admin",
	usedThisMonth: 0,
	priceSources: [],
	hostListed: true,
};

const ROW: AdminModelPrice = {
	id: "00000000-0000-4000-8000-000000000001",
	provider: "anthropic",
	model: "opus-5-5",
	inputPricePerMillion: 5,
	cacheReadRatio: 0.1,
	cacheWriteRatio: 1.25,
	cacheWriteOneHourRatio: 2,
	cacheTtlSeconds: 300,
	surchargeAboveTokens: null,
	surchargeFactor: null,
	sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
	sourceQuote: "Opus 5.5: $5 / MTok",
	checkedAt: "2026-11-10T00:00:00.000Z",
	updatedAt: "2026-11-10T00:00:00.000Z",
};

const RUN: PriceRun = {
	id: "00000000-0000-4000-8000-0000000000a1",
	trigger: "weekly",
	status: "done",
	startedAt: "2026-11-15T03:00:00.000Z",
	finishedAt: "2026-11-15T03:01:00.000Z",
	errorCode: "developers.openai.com:refused",
	proposalCount: 1,
};

const { id: _id, ...ROW_FIGURES } = ROW;
const PROPOSAL: PriceProposal = {
	...ROW_FIGURES,
	id: "00000000-0000-4000-8000-0000000000b1",
	runId: RUN.id,
	status: "pending",
	cacheReadRatio: 0.05,
	current: ROW_FIGURES,
	decidedAt: null,
	decidedBy: null,
	sourceQuote: "Opus 5.5: cache hits $0.25 / MTok",
};

type Sent = { url: string; method: string; body: unknown }[];

function serve(
	opts: {
		ai?: AiSettingsView;
		run?: PriceRun | null;
		prices?: AdminModelPrice[];
		proposals?: PriceProposal[];
		proxy?: { operatorHosts: string[]; hosts: string[] } | null;
	} = {},
) {
	let ai = opts.ai ?? AI;
	let prices = opts.prices ?? [ROW];
	let proposals = opts.proposals ?? [PROPOSAL];
	const sent: Sent = [];
	stubFetch((url, init) => {
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		sent.push({ url, method, body });
		if (url === "/admin/ai") {
			if (method === "PUT") ai = { ...ai, priceSources: body.priceSources };
			return json(200, ai);
		}
		if (url === "/admin/proxy-hosts") {
			if (opts.proxy === null)
				return json(404, { error: { code: "NOT_FOUND", message: "Not found." } });
			return json(200, {
				...(opts.proxy ?? { operatorHosts: [], hosts: [] }),
				job: null,
			});
		}
		if (url === "/admin/pricing")
			return json(200, {
				prices,
				run: opts.run === undefined ? RUN : opts.run,
				proposals,
			});
		if (url === "/admin/pricing/refresh")
			return json(202, {
				...RUN,
				status: "running",
				errorCode: null,
				trigger: "manual",
			});
		if (url.endsWith("/decision")) {
			proposals = proposals.filter((p) => !url.includes(p.id));
			return json(200, { prices, proposals });
		}
		if (url === "/admin/pricing/rows" && method === "POST") {
			prices = [
				...prices,
				{ ...ROW, ...body, id: "00000000-0000-4000-8000-000000000002" },
			];
			return json(201, { prices });
		}
		if (url.startsWith("/admin/pricing/rows/") && method === "DELETE") {
			prices = [];
			return json(200, { prices });
		}
		return json(404, { error: { code: "NOT_FOUND", message: "Not found." } });
	});
	return sent;
}

test("the table lists each row's figures, with the source quote behind a disclosure", async () => {
	serve();
	renderWithQuery(<PricingTab />);
	const row = await screen.findByTestId("price-row-opus-5-5");
	expect(row.textContent).toMatch(/Anthropic/);
	expect(row.textContent).toMatch(/\$5\.00/);
	expect(row.textContent).toMatch(/2× for one hour/);
	expect(row.textContent).toMatch(/5 min/);
	expect(within(row).getByRole("link", { name: "platform.claude.com" })).toBeTruthy();
	expect(within(row).getByText("Quote")).toBeTruthy();
	expect(row.textContent).toMatch(/Opus 5\.5: \$5 \/ MTok/);
});

test("the last run shows its trigger, and a refused source its sentence and a pointer to Sources", async () => {
	serve();
	renderWithQuery(<PricingTab />);
	const last = await screen.findByTestId("pricing-last-run");
	expect(last.textContent).toMatch(/Weekly check/);
	expect(last.textContent).toMatch(/Done/);
	const failure = within(screen.getByTestId("pricing-run-failures")).getByText(
		/refused/,
	);
	expect(failure.closest("li")?.textContent).toMatch(/developers\.openai\.com/);
	expect(
		within(screen.getByTestId("pricing-run-failures")).getByRole("link", {
			name: "Go to Sources",
		}),
	).toBeTruthy();
});

test("a proposal marks only the changed figures, and accepting sends the decision", async () => {
	const sent = serve();
	renderWithQuery(<PricingTab />);
	const proposal = await screen.findByTestId("proposal-opus-5-5");
	const changed = proposal.querySelectorAll("tr[data-changed]");
	expect(changed).toHaveLength(1);
	expect(changed[0]?.textContent).toMatch(/Cache read.*0\.1×.*0\.05×/);
	expect(proposal.textContent).toMatch(/cache hits \$0\.25/);
	fireEvent.click(within(proposal).getByTestId("proposal-accept"));
	await waitFor(() => expect(screen.queryByTestId("pricing-proposals")).toBeNull());
	expect(sent.find((r) => r.url.endsWith("/decision"))).toMatchObject({
		url: `/admin/pricing/proposals/${PROPOSAL.id}/decision`,
		body: { decision: "accept" },
	});
});

test("Check prices now says why it is off while the assistant is unavailable", async () => {
	const sent = serve({ ai: { ...AI, enabled: false } });
	renderWithQuery(<PricingTab />);
	const reason = await screen.findByTestId("pricing-refresh-reason");
	expect(reason.textContent).toBe("Turn on the assistant on the AI tab first.");
	fireEvent.click(screen.getByTestId("pricing-refresh"));
	expect(sent.some((r) => r.url === "/admin/pricing/refresh")).toBe(false);
});

test("a missing key or notice is named, and a running check blocks another", async () => {
	serve({
		ai: { ...AI, keySet: false },
		run: { ...RUN, status: "running", errorCode: null },
	});
	renderWithQuery(<PricingTab />);
	expect((await screen.findByTestId("pricing-refresh-reason")).textContent).toMatch(
		/A check is running/,
	);
	cleanup();
	serve({ ai: { ...AI, keySet: false }, run: null });
	renderWithQuery(<PricingTab />);
	expect((await screen.findByTestId("pricing-refresh-reason")).textContent).toBe(
		"Set the provider's key first on the AI tab.",
	);
	expect(screen.getByText("No check has run yet.")).toBeTruthy();
});

test("Check prices now starts a run and shows it running", async () => {
	const sent = serve({ run: null, proposals: [] });
	renderWithQuery(<PricingTab />);
	fireEvent.click(await screen.findByTestId("pricing-refresh"));
	await waitFor(() =>
		expect(screen.getByTestId("pricing-run-status").textContent).toBe("Running"),
	);
	expect(
		sent.some((r) => r.url === "/admin/pricing/refresh" && r.method === "POST"),
	).toBe(true);
});

test("adding a row checks the fields against the contract before it sends", async () => {
	const sent = serve({ prices: [], proposals: [], run: null });
	renderWithQuery(<PricingTab />);
	expect(await screen.findByText("No prices yet")).toBeTruthy();
	fireEvent.click(screen.getByTestId("price-row-add"));
	const dialog = await screen.findByTestId("price-row-dialog");
	fireEvent.click(within(dialog).getByTestId("price-row-save"));
	expect(await within(dialog).findByText(/Give the model's name/)).toBeTruthy();
	expect(sent.some((r) => r.url === "/admin/pricing/rows")).toBe(false);
	const type = (label: RegExp, value: string) =>
		fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
	type(/^Model/, "gpt-7");
	type(/^Input price/, "2");
	type(/^Cache read ratio/, "0.1");
	type(/^Cache write ratio/, "1.25");
	type(/^Source page/, "https://developers.openai.com/api/docs/pricing");
	type(/^Quote from the source/, "GPT-7: $2 / 1M input");
	fireEvent.click(within(dialog).getByTestId("price-row-save"));
	await screen.findByTestId("price-row-gpt-7");
	expect(sent.find((r) => r.url === "/admin/pricing/rows")?.body).toMatchObject({
		model: "gpt-7",
		inputPricePerMillion: 2,
		cacheWriteOneHourRatio: null,
	});
});

test("deleting a row asks first", async () => {
	const sent = serve({ proposals: [] });
	renderWithQuery(<PricingTab />);
	fireEvent.click(await screen.findByTestId("price-row-delete"));
	const confirm = await screen.findByTestId("price-row-delete-dialog");
	expect(sent.some((r) => r.method === "DELETE")).toBe(false);
	fireEvent.click(within(confirm).getByRole("button", { name: "Delete row" }));
	await screen.findByText("No prices yet");
	expect(sent.find((r) => r.method === "DELETE")?.url).toBe(
		`/admin/pricing/rows/${ROW.id}`,
	);
});

test("the default sources show when none are saved, and an unlisted host is offered, ticked", async () => {
	const sent = serve({
		proposals: [],
		proxy: { operatorHosts: ["platform.claude.com"], hosts: [] },
	});
	renderWithQuery(<PricingTab />);
	const list = await screen.findByTestId("pricing-source-list");
	expect(list.textContent).toMatch(/developers\.openai\.com\/api\/docs\/pricing/);
	expect(list.textContent).toMatch(/platform\.claude\.com/);
	const offer = await screen.findByTestId("pricing-proxy-offer");
	expect(offer.textContent).toMatch(/reach developers\.openai\.com on port 443/);
	expect(within(offer).getByRole("checkbox")).toHaveProperty("checked", true);
	fireEvent.change(screen.getByLabelText(/^Add a page/), {
		target: { value: "http://x" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Add" }));
	expect(await screen.findByText(/https:\/\/ address/)).toBeTruthy();
	fireEvent.change(screen.getByLabelText(/^Add a page/), {
		target: { value: "https://prices.example.com/llm" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Add" }));
	fireEvent.click(screen.getByTestId("pricing-sources-save"));
	await waitFor(() =>
		expect(sent.find((r) => r.url === "/admin/ai" && r.method === "PUT")?.body).toEqual(
			{
				priceSources: [
					"https://developers.openai.com/api/docs/pricing",
					"https://platform.claude.com/docs/en/about-claude/pricing",
					"https://prices.example.com/llm",
				],
				addProxyHost: true,
			},
		),
	);
});

test("with no proxy host list on this server nothing is offered, and an unticked offer is not sent", async () => {
	serve({ proposals: [], proxy: null });
	renderWithQuery(<PricingTab />);
	await screen.findByTestId("pricing-source-list");
	await waitFor(() => expect(screen.queryByTestId("pricing-proxy-offer")).toBeNull());
	cleanup();
	const sent = serve({
		proposals: [],
		ai: { ...AI, priceSources: ["https://a.example.com/p"] },
	});
	renderWithQuery(<PricingTab />);
	const offer = await screen.findByTestId("pricing-proxy-offer");
	fireEvent.click(within(offer).getByRole("checkbox"));
	fireEvent.click(
		screen.getByRole("button", { name: "Remove https://a.example.com/p" }),
	);
	fireEvent.click(screen.getByTestId("pricing-sources-save"));
	await waitFor(() =>
		expect(sent.find((r) => r.method === "PUT")?.body).toEqual({ priceSources: [] }),
	);
});

const SECOND: PriceProposal = {
	...PROPOSAL,
	id: "00000000-0000-4000-8000-0000000000b2",
	model: "sonnet-5-5",
	current: null,
};

test("deciding a proposal moves focus to the next one, and the last to the Prices heading", async () => {
	serve({ proposals: [PROPOSAL, SECOND] });
	renderWithQuery(<PricingTab />);
	const first = await screen.findByTestId("proposal-opus-5-5");
	expect(within(first).getByRole("button", { name: "Reject opus-5-5" })).toBeTruthy();
	fireEvent.click(within(first).getByTestId("proposal-accept"));
	await waitFor(() => expect(screen.queryByTestId("proposal-opus-5-5")).toBeNull());
	expect(document.activeElement?.id).toBe(`proposal-${SECOND.id}`);
	const second = screen.getByTestId("proposal-sonnet-5-5");
	fireEvent.click(within(second).getByRole("button", { name: "Reject sonnet-5-5" }));
	await waitFor(() => expect(screen.queryByTestId("pricing-proposals")).toBeNull());
	expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Prices" }));
});

test("cancelling a row's delete returns focus to its trash button", async () => {
	serve({ proposals: [] });
	renderWithQuery(<PricingTab />);
	const trash = await screen.findByTestId("price-row-delete");
	trash.focus();
	fireEvent.click(trash);
	const confirm = await screen.findByTestId("price-row-delete-dialog");
	fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
	await waitFor(() =>
		expect(screen.queryByTestId("price-row-delete-dialog")).toBeNull(),
	);
	await waitFor(() => expect(document.activeElement).toBe(trash));
});

test("removing a source moves focus to the next Remove, and the last to the add field", async () => {
	serve({ proposals: [] });
	renderWithQuery(<PricingTab />);
	const list = await screen.findByTestId("pricing-source-list");
	const removes = within(list).getAllByRole("button");
	expect(removes).toHaveLength(2);
	fireEvent.click(removes[0] as HTMLElement);
	expect(document.activeElement).toBe(removes[1]);
	fireEvent.click(removes[1] as HTMLElement);
	expect(document.activeElement).toBe(screen.getByLabelText(/^Add a page/));
});

test("a full list's Add stays focusable, points at the limit and adds nothing", async () => {
	const full = Array.from({ length: 20 }, (_, i) => `https://p${i}.example.com/`);
	serve({ proposals: [], ai: { ...AI, priceSources: full } });
	renderWithQuery(<PricingTab />);
	const add = await screen.findByRole("button", { name: "Add" });
	expect((add as HTMLButtonElement).disabled).toBe(false);
	expect(add.getAttribute("aria-disabled")).toBe("true");
	const hint = document.getElementById(add.getAttribute("aria-describedby") ?? "");
	expect(hint?.textContent).toMatch(/at most 20 pages/);
	fireEvent.change(screen.getByLabelText(/^Add a page/), {
		target: { value: "https://more.example.com/" },
	});
	fireEvent.click(add);
	expect(screen.getByTestId("pricing-source-list").textContent).not.toMatch(
		/more\.example/,
	);
});
