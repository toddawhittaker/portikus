import type { AdminEgressView } from "@portikus/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../../test-utils.js";
import { NetworkTab } from "./NetworkTab.js";
import { egressView } from "./testView.js";

afterEach(() => vi.unstubAllGlobals());

interface Call {
	method: string;
	url: string;
	body: unknown;
}

/** Serves the egress view; each write answers `answer(call)` or the view with the version raised. */
function stubEgress(
	start: AdminEgressView,
	answer?: (call: Call) => Response | undefined,
): Call[] {
	let view = start;
	const calls: Call[] = [];
	stubFetch((url, init) => {
		const method = init?.method ?? "GET";
		if (method === "GET" && url === "/admin/egress") return json(200, view);
		const call = {
			method,
			url,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		};
		calls.push(call);
		const special = answer?.(call);
		if (special) return special;
		view = { ...view, version: view.version + 1 };
		return json(200, view);
	});
	return calls;
}

async function shown() {
	return screen.findByTestId("egress-tab");
}

test("shows a skeleton, then the policy and its applied status", async () => {
	stubEgress(egressView());
	renderWithQuery(<NetworkTab />);
	expect(screen.getByTestId("egress-loading")).toBeDefined();
	await shown();
	expect(screen.getByTestId("egress-apply-status").textContent).toContain("Applied");
	expect(
		screen.getByTestId("egress-mode-allow-list").getAttribute("aria-pressed"),
	).toBe("true");
	expect(screen.queryByTestId("egress-open-note")).toBeNull();
});

test("the mode summary is stated as fact only once the policy is applied", async () => {
	stubEgress(egressView());
	renderWithQuery(<NetworkTab />);
	await shown();
	expect(screen.getByTestId("egress-mode-summary").textContent).toMatch(
		/^Workspaces can reach only/,
	);
	cleanup();
	stubEgress(
		egressView({ apply: { appliedVersion: 2, appliedAt: null, error: null } }),
	);
	renderWithQuery(<NetworkTab />);
	await shown();
	expect(screen.getByTestId("egress-mode-summary").textContent).toMatch(
		/^Saved setting: Workspaces can reach only/,
	);
	cleanup();
	stubEgress(
		egressView({
			apply: { appliedVersion: 2, appliedAt: null, error: "the gateway refused it" },
		}),
	);
	renderWithQuery(<NetworkTab />);
	await shown();
	expect(screen.getByTestId("egress-mode-summary").textContent).toMatch(
		/^Saved setting: /,
	);
});

test("a read failure is shown with a way to try again", async () => {
	let fail = true;
	stubFetch(() =>
		fail
			? json(500, { code: "INTERNAL", message: "The policy is unavailable." })
			: json(200, egressView()),
	);
	renderWithQuery(<NetworkTab />);
	expect((await screen.findByRole("alert")).textContent).toBe(
		"The policy is unavailable.",
	);
	fail = false;
	fireEvent.click(screen.getByRole("button", { name: "Try again" }));
	await shown();
});

test("switching mode asks first; cancel writes nothing and confirm saves", async () => {
	const calls = stubEgress(egressView({ mode: "open" }));
	renderWithQuery(<NetworkTab />);
	await shown();
	expect(screen.getByTestId("egress-open-note")).toBeDefined();

	fireEvent.click(screen.getByTestId("egress-mode-allow-list"));
	const dialog = await screen.findByTestId("egress-mode-dialog");
	expect(dialog.textContent).toContain(
		"Workspaces will reach only the 4 hosts and 1 range listed, on ports 22, 80 and 443.",
	);
	expect(dialog.textContent).toContain('"Could not resolve host"');
	fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
	await waitFor(() => expect(screen.queryByTestId("egress-mode-dialog")).toBeNull());
	expect(calls).toEqual([]);

	fireEvent.click(screen.getByTestId("egress-mode-allow-list"));
	fireEvent.click(await screen.findByTestId("dialog-confirm"));
	await waitFor(() => expect(calls).toHaveLength(1));
	expect(calls[0]).toEqual({
		method: "PUT",
		url: "/admin/egress/mode",
		body: { version: 3, mode: "allow-list" },
	});
	await waitFor(() => expect(screen.queryByTestId("egress-mode-dialog")).toBeNull());
});

test("clicking the current mode does nothing; open mode's dialog says the list is kept", async () => {
	stubEgress(egressView({ presets: [], entries: [] }));
	renderWithQuery(<NetworkTab />);
	await shown();
	fireEvent.click(screen.getByTestId("egress-mode-allow-list"));
	expect(screen.queryByTestId("egress-mode-dialog")).toBeNull();
	fireEvent.click(screen.getByTestId("egress-mode-open"));
	expect((await screen.findByTestId("egress-mode-dialog")).textContent).toContain(
		"kept for next time",
	);
});

test("an empty list warns that allow-list mode reaches nothing", async () => {
	stubEgress(egressView({ mode: "open", presets: [], entries: [] }));
	renderWithQuery(<NetworkTab />);
	await shown();
	fireEvent.click(screen.getByTestId("egress-mode-allow-list"));
	expect((await screen.findByTestId("egress-mode-dialog")).textContent).toContain(
		"Nothing is listed yet",
	);
});

test("a stale version says someone else changed it and reloads", async () => {
	stubEgress(egressView({ mode: "open" }), () =>
		json(409, { code: "EGRESS_VERSION_STALE", message: "stale" }),
	);
	renderWithQuery(<NetworkTab />);
	await shown();
	fireEvent.click(screen.getByTestId("egress-mode-allow-list"));
	fireEvent.click(await screen.findByTestId("dialog-confirm"));
	expect((await screen.findByRole("alert")).textContent).toContain(
		"Someone else changed the network policy, so it was reloaded.",
	);
});

test("a preset turns on and off, keeping catalogue order", async () => {
	const calls = stubEgress(egressView({ presets: ["github"] }));
	renderWithQuery(<NetworkTab />);
	await shown();
	const npm = screen.getByTestId("egress-preset-npm");
	expect(within(npm).getByText("npmjs.org")).toBeDefined();
	fireEvent.click(within(npm).getByRole("checkbox"));
	await waitFor(() => expect(calls).toHaveLength(1));
	expect(calls[0]?.body).toEqual({ version: 3, presets: ["npm", "github"] });
	await waitFor(() =>
		expect(
			within(screen.getByTestId("egress-preset-github")).getByRole("checkbox"),
		).toHaveProperty("disabled", false),
	);
	fireEvent.click(
		within(screen.getByTestId("egress-preset-github")).getByRole("checkbox"),
	);
	await waitFor(() => expect(calls).toHaveLength(2));
	expect(calls[1]?.body).toEqual({ version: 4, presets: [] });
});

test("adding an entry checks it with the contracts' rules first", async () => {
	const calls = stubEgress(egressView({ entries: [] }));
	renderWithQuery(<NetworkTab />);
	await shown();
	expect(screen.getByText("No hosts or ranges yet")).toBeDefined();
	fireEvent.click(screen.getByTestId("egress-add"));
	const dialog = await screen.findByTestId("egress-entry-dialog");
	fireEvent.click(within(dialog).getByTestId("egress-entry-save"));
	expect(within(dialog).getByRole("alert").textContent).toBe("Enter a host name.");

	const value = within(dialog).getByTestId("egress-entry-value");
	fireEvent.change(value, { target: { value: "https://x.org/a" } });
	expect(within(dialog).getByRole("alert").textContent).toContain(
		"Enter a host name such as github.com",
	);
	fireEvent.click(within(dialog).getByTestId("egress-kind-range"));
	fireEvent.change(value, { target: { value: "10.0.0.0/16" } });
	expect(within(dialog).getByRole("alert").textContent).toContain(
		"overlaps the private range 10.0.0.0/8",
	);
	fireEvent.change(value, { target: { value: "203.0.113.0/24" } });
	fireEvent.change(within(dialog).getByTestId("egress-entry-label"), {
		target: { value: "x".repeat(81) },
	});
	expect(within(dialog).getByRole("alert").textContent).toContain("80 characters");
	fireEvent.change(within(dialog).getByTestId("egress-entry-label"), {
		target: { value: "Lab" },
	});
	expect(calls).toEqual([]);
	fireEvent.keyDown(value, { key: "Enter" });
	await waitFor(() => expect(calls).toHaveLength(1));
	expect(calls[0]).toEqual({
		method: "POST",
		url: "/admin/egress/entries",
		body: { version: 3, kind: "range", value: "203.0.113.0/24", label: "Lab" },
	});
	await waitFor(() => expect(screen.queryByTestId("egress-entry-dialog")).toBeNull());
});

test("the API's refusal stays in the dialog", async () => {
	stubEgress(egressView(), () =>
		json(409, { code: "EGRESS_ENTRY_EXISTS", message: "That entry is already listed" }),
	);
	renderWithQuery(<NetworkTab />);
	await shown();
	fireEvent.click(screen.getByTestId("egress-add"));
	const dialog = await screen.findByTestId("egress-entry-dialog");
	fireEvent.change(within(dialog).getByTestId("egress-entry-value"), {
		target: { value: "api.example.edu" },
	});
	fireEvent.click(within(dialog).getByTestId("egress-entry-save"));
	expect((await within(dialog).findByTestId("egress-entry-error")).textContent).toBe(
		"That entry is already listed",
	);
});

test("an entry can be edited and removed", async () => {
	const calls = stubEgress(egressView());
	renderWithQuery(<NetworkTab />);
	await shown();
	fireEvent.click(screen.getByRole("button", { name: "Edit api.example.edu" }));
	const dialog = await screen.findByTestId("egress-entry-dialog");
	expect(within(dialog).getByTestId("egress-entry-label")).toHaveProperty(
		"value",
		"Course API",
	);
	fireEvent.change(within(dialog).getByTestId("egress-entry-label"), {
		target: { value: "Course 101" },
	});
	fireEvent.click(within(dialog).getByTestId("egress-entry-save"));
	await waitFor(() => expect(calls).toHaveLength(1));
	expect(calls[0]).toEqual({
		method: "PUT",
		url: "/admin/egress/entries/11111111-1111-4111-8111-111111111111",
		body: { version: 3, kind: "host", value: "api.example.edu", label: "Course 101" },
	});
	await waitFor(() => expect(screen.queryByTestId("egress-entry-dialog")).toBeNull());

	fireEvent.click(screen.getByRole("button", { name: "Remove 203.0.113.0/24" }));
	const confirm = await screen.findByTestId("egress-remove-dialog");
	expect(confirm.textContent).toContain("Workspaces stop reaching it");
	fireEvent.click(within(confirm).getByTestId("dialog-confirm"));
	await waitFor(() => expect(calls).toHaveLength(2));
	expect(calls[1]).toMatchObject({
		method: "DELETE",
		url: "/admin/egress/entries/22222222-2222-4222-8222-222222222222?version=4",
	});
});

test("removing in open mode says nothing changes yet", async () => {
	stubEgress(egressView({ mode: "open" }));
	renderWithQuery(<NetworkTab />);
	await shown();
	fireEvent.click(screen.getByRole("button", { name: "Remove api.example.edu" }));
	expect((await screen.findByTestId("egress-remove-dialog")).textContent).toContain(
		"nothing changes for workspaces",
	);
});

test("ports are checked, then saved sorted", async () => {
	const calls = stubEgress(egressView());
	renderWithQuery(<NetworkTab />);
	await shown();
	const field = screen.getByTestId("egress-ports");
	expect(field).toHaveProperty("value", "22, 80, 443");
	fireEvent.change(field, { target: { value: "443, ssh" } });
	fireEvent.click(screen.getByTestId("egress-ports-save"));
	expect(screen.getByRole("alert").textContent).toContain("ssh is not a port");
	fireEvent.change(field, { target: { value: "8443, 443" } });
	fireEvent.click(screen.getByTestId("egress-ports-save"));
	await waitFor(() => expect(calls).toHaveLength(1));
	expect(calls[0]?.body).toEqual({ version: 3, ports: [443, 8443] });
});

test("a refused ports write shows the API's message", async () => {
	stubEgress(egressView(), () =>
		json(400, { code: "VALIDATION_FAILED", message: "Bad ports" }),
	);
	renderWithQuery(<NetworkTab />);
	await shown();
	fireEvent.click(screen.getByTestId("egress-ports-save"));
	expect((await screen.findByRole("alert")).textContent).toBe("Bad ports");
});

test("testing a host explains the answer and offers to allow an unlisted one", async () => {
	stubEgress(egressView());
	renderWithQuery(<NetworkTab />);
	await shown();
	const input = screen.getByTestId("egress-test-input");
	fireEvent.change(input, { target: { value: "https://api.github.com/repos" } });
	fireEvent.click(screen.getByTestId("egress-test-run"));
	expect(screen.getByTestId("egress-test-result").textContent).toContain(
		"Allowed by the GitHub preset",
	);
	expect(screen.queryByTestId("egress-test-allow")).toBeNull();

	fireEvent.change(input, { target: { value: "Example.ORG" } });
	fireEvent.click(screen.getByTestId("egress-test-run"));
	expect(screen.getByTestId("egress-test-result").dataset.reason).toBe("not-listed");
	fireEvent.click(screen.getByTestId("egress-test-allow"));
	const dialog = await screen.findByTestId("egress-entry-dialog");
	expect(within(dialog).getByTestId("egress-entry-value")).toHaveProperty(
		"value",
		"example.org",
	);
});

test("refused names offer Allow… unless already allowed or not a name", async () => {
	stubEgress(
		egressView({
			blocked: [
				{ name: "registry.example.com", count: 1200 },
				{ name: "api.github.com", count: 3 },
				{ name: "(other names)", count: 9 },
			],
		}),
	);
	renderWithQuery(<NetworkTab />);
	await shown();
	const rows = screen.getAllByTestId("egress-blocked-row");
	expect(rows.map((row) => row.textContent)).toEqual([
		"registry.example.com1,200Allow…",
		"api.github.com3Listed now",
		"(other names)9",
	]);
	fireEvent.click(screen.getByRole("button", { name: "Allow registry.example.com…" }));
	const dialog = await screen.findByTestId("egress-entry-dialog");
	expect(within(dialog).getByTestId("egress-entry-value")).toHaveProperty(
		"value",
		"registry.example.com",
	);
	fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
	await waitFor(() => expect(screen.queryByTestId("egress-entry-dialog")).toBeNull());
});

test("no refused names shows an empty state for each mode", async () => {
	stubEgress(egressView({ mode: "open", blockedSites: [] }));
	renderWithQuery(<NetworkTab />);
	await shown();
	expect(
		screen.getByText("Open mode is on and nothing is blocked, so no site is refused."),
	).toBeDefined();
});

test("open mode with blocked sites still expects refusals", async () => {
	stubEgress(egressView({ mode: "open" }));
	renderWithQuery(<NetworkTab />);
	await shown();
	expect(
		screen.getByText("No workspace was refused a site in the last 7 days."),
	).toBeDefined();
});

describe("blocked sites (ADR 0043)", () => {
	test("lists each site with its label, and counts toward 500", async () => {
		stubEgress(egressView({ mode: "open" }));
		renderWithQuery(<NetworkTab />);
		await shown();
		const rows = screen.getAllByTestId("egress-block-row");
		expect(rows.map((r) => r.textContent)).toEqual([
			expect.stringContaining("dns.googleDNS over HTTPS service"),
			expect.stringContaining("games.example.comGames"),
		]);
		expect(rows[0]?.textContent).not.toContain("default");
		expect(screen.getByText(/2 of 500 used/)).toBeDefined();
		expect(screen.getByTestId("egress-block-note").textContent).toContain(
			"QUIC is dropped",
		);
	});

	test("comes first in open mode and after Ports in allow-list mode", async () => {
		const headings = () =>
			screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
		stubEgress(egressView({ mode: "open" }));
		renderWithQuery(<NetworkTab />);
		await shown();
		const open = headings();
		expect(open.indexOf("Blocked sites")).toBeLessThan(open.indexOf("Presets"));
		cleanup();
		stubEgress(egressView());
		renderWithQuery(<NetworkTab />);
		await shown();
		const allow = headings();
		expect(allow.indexOf("Blocked sites")).toBe(allow.indexOf("Ports") + 1);
	});

	test("allow-list mode says the list is not used", async () => {
		stubEgress(egressView());
		renderWithQuery(<NetworkTab />);
		await shown();
		expect(screen.getByTestId("egress-block-note").textContent).toContain(
			"Allow-list mode is on, so this list is not used",
		);
	});

	test("an empty list in open mode is one line of text with an example, not a table", async () => {
		stubEgress(egressView({ mode: "open", blockedSites: [] }));
		renderWithQuery(<NetworkTab />);
		await shown();
		const card = screen.getByRole("region", { name: "Blocked sites" });
		expect(within(card).queryByRole("table")).toBeNull();
		expect(screen.getByTestId("egress-block-note").textContent).toContain(
			"Nothing is blocked, so workspaces reach every public site. Blocking a site, such as games.example.com",
		);
		expect(within(card).getByText(/0 of 500 used/)).toBeDefined();
	});

	test("an empty list in allow-list mode collapses to its heading, one note and Block", async () => {
		stubEgress(egressView({ blockedSites: [] }));
		renderWithQuery(<NetworkTab />);
		await shown();
		const card = screen.getByRole("region", { name: "Blocked sites" });
		expect(within(card).queryByRole("table")).toBeNull();
		expect(within(card).queryByText(/of 500 used/)).toBeNull();
		expect(within(card).getByTestId("egress-block-note").textContent).toBe(
			"Allow-list mode is on, so this list is not used until you switch to open mode.",
		);
		expect(within(card).getByRole("button", { name: "Block…" })).toBeDefined();
	});

	test("blocking a site checks it first, then posts it with its label", async () => {
		const calls = stubEgress(egressView({ mode: "open" }));
		renderWithQuery(<NetworkTab />);
		await shown();
		fireEvent.click(screen.getByTestId("egress-block-add"));
		const dialog = await screen.findByTestId("egress-block-dialog");
		fireEvent.change(within(dialog).getByTestId("egress-block-value"), {
			target: { value: "https://x.com/a" },
		});
		fireEvent.click(within(dialog).getByTestId("egress-block-save"));
		expect(dialog.textContent).toContain("no URL");
		expect(calls).toEqual([]);

		fireEvent.change(within(dialog).getByTestId("egress-block-value"), {
			target: { value: "Chess.Example.COM" },
		});
		fireEvent.change(within(dialog).getByTestId("egress-block-label"), {
			target: { value: "Games" },
		});
		fireEvent.keyDown(within(dialog).getByTestId("egress-block-label"), {
			key: "Enter",
		});
		await waitFor(() => expect(screen.queryByTestId("egress-block-dialog")).toBeNull());
		expect(calls).toEqual([
			{
				method: "POST",
				url: "/admin/egress/blocked-sites",
				body: { version: 3, value: "Chess.Example.COM", label: "Games" },
			},
		]);
	});

	test("the API's refusal stays in the dialog", async () => {
		stubEgress(egressView({ mode: "open" }), () =>
			json(409, {
				code: "EGRESS_ENTRY_EXISTS",
				message: "That site is already blocked",
			}),
		);
		renderWithQuery(<NetworkTab />);
		await shown();
		fireEvent.click(screen.getByTestId("egress-block-add"));
		const dialog = await screen.findByTestId("egress-block-dialog");
		fireEvent.change(within(dialog).getByTestId("egress-block-value"), {
			target: { value: "dns.google" },
		});
		fireEvent.click(within(dialog).getByTestId("egress-block-save"));
		expect((await within(dialog).findByTestId("egress-block-error")).textContent).toBe(
			"That site is already blocked",
		);
	});

	test("a site can be edited, and removed after confirming, focusing the card heading", async () => {
		const calls = stubEgress(egressView({ mode: "open" }));
		renderWithQuery(<NetworkTab />);
		await shown();
		fireEvent.click(screen.getByRole("button", { name: "Edit games.example.com" }));
		const dialog = await screen.findByTestId("egress-block-dialog");
		expect(within(dialog).getByTestId("egress-block-value")).toHaveProperty(
			"value",
			"games.example.com",
		);
		fireEvent.change(within(dialog).getByTestId("egress-block-label"), {
			target: { value: "" },
		});
		fireEvent.click(within(dialog).getByTestId("egress-block-save"));
		await waitFor(() => expect(screen.queryByTestId("egress-block-dialog")).toBeNull());
		expect(calls[0]).toEqual({
			method: "PUT",
			url: "/admin/egress/blocked-sites/55555555-5555-4555-8555-555555555555",
			body: { version: 3, value: "games.example.com", label: "" },
		});

		fireEvent.click(screen.getByRole("button", { name: "Remove dns.google" }));
		const confirm = await screen.findByTestId("egress-block-remove-dialog");
		expect(confirm.textContent).toContain("Workspaces can reach it again");
		fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
		await waitFor(() =>
			expect(screen.queryByTestId("egress-block-remove-dialog")).toBeNull(),
		);
		expect(calls[1]).toEqual({
			method: "DELETE",
			url: "/admin/egress/blocked-sites/44444444-4444-4444-8444-444444444444?version=4",
			body: undefined,
		});
		await waitFor(() =>
			expect(document.activeElement?.id).toBe("egress-blocked-sites-title"),
		);
	});

	test("Test a host explains a block in open mode, and refused rows mark blocked sites", async () => {
		stubEgress(
			egressView({ mode: "open", blocked: [{ name: "games.example.com", count: 4 }] }),
		);
		renderWithQuery(<NetworkTab />);
		await shown();
		fireEvent.change(screen.getByTestId("egress-test-input"), {
			target: { value: "https://play.games.example.com/x" },
		});
		fireEvent.click(screen.getByTestId("egress-test-run"));
		const result = screen.getByTestId("egress-test-result");
		expect(result.dataset.reason).toBe("blocked");
		expect(result.textContent).toContain(
			"Blocked by your list: games.example.com (Games).",
		);
		expect(screen.queryByTestId("egress-test-allow")).toBeNull();
		const row = screen.getByTestId("egress-blocked-row");
		expect(row.textContent).toContain("Blocked site");
		expect(within(row).queryByRole("button")).toBeNull();
	});
});
