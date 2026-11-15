/** The admin API keys tab (SPEC.md sections 24.8 and 24.13). */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../../test-utils.js";
import { ApiKeysTab, keyOwners } from "./ApiKeysTab.js";

const ADA = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";

function key(n: number, state: string, owner: string) {
	return {
		id: `3333333${n}-3333-4333-8333-333333333333`,
		name: `Key ${n}`,
		prefix: `portikus_k${n}`,
		scope: "write",
		periodDays: 30,
		state,
		createdAt: "2026-11-01T10:00:00.000Z",
		expiresAt: "2026-12-01T10:00:00.000Z",
		lastUsedAt: null,
		revokedAt: state === "revoked" ? "2026-11-10T10:00:00.000Z" : null,
		owner: {
			id: owner,
			displayName: owner === ADA ? "Ada Admin" : "Ben Instructor",
			role: owner === ADA ? "administrator" : "instructor",
		},
	};
}

const KEYS = [
	key(1, "active", ADA),
	key(2, "expired", ADA),
	key(3, "revoked", ADA),
	key(4, "active", BEN),
];

let posts: string[];

beforeEach(() => {
	posts = [];
	stubFetch((url, init) => {
		if (init?.method === "POST") {
			posts.push(url);
			return json(200, { affected: 2 });
		}
		if (url === "/admin/api-keys") return json(200, { keys: KEYS });
		throw new Error(`unexpected request to ${url}`);
	});
});

afterEach(() => vi.unstubAllGlobals());

test("the owners are listed once each, by name", () => {
	expect(keyOwners(KEYS as never)).toEqual([
		{ value: ADA, label: "Ada Admin" },
		{ value: BEN, label: "Ben Instructor" },
	]);
});

test("every key on the site shows with its owner, and a revoked key has no actions", async () => {
	renderWithQuery(<ApiKeysTab />);
	const table = await screen.findByTestId("api-keys-table");
	expect(within(table).getAllByRole("row")).toHaveLength(5);
	const first = within(screen.getByTestId("admin-api-key-portikus_k1"));
	expect(first.getByText("Ada Admin")).toBeDefined();
	expect(first.getByText("Write")).toBeDefined();
	expect(first.getByRole("button", { name: "Expire…" })).toBeDefined();
	// Expired keys can only be revoked; revoked keys keep nothing.
	const expired = within(screen.getByTestId("admin-api-key-portikus_k2"));
	expect(expired.queryByRole("button", { name: "Expire…" })).toBeNull();
	expect(expired.getByRole("button", { name: "Revoke…" })).toBeDefined();
	expect(
		within(screen.getByTestId("admin-api-key-portikus_k3")).queryAllByRole("button"),
	).toHaveLength(0);
});

test("expire one key confirms with its count and posts to that key", async () => {
	renderWithQuery(<ApiKeysTab />);
	await screen.findByTestId("api-keys-table");
	fireEvent.click(
		within(screen.getByTestId("admin-api-key-portikus_k1")).getByRole("button", {
			name: "Expire…",
		}),
	);
	const confirm = await screen.findByTestId("api-keys-confirm");
	expect(confirm.textContent).toContain("This affects 1 key");
	expect(confirm.textContent).toContain("can be renewed by its owner");
	fireEvent.click(within(confirm).getByRole("button", { name: "Expire key" }));
	await waitFor(() =>
		expect(posts).toEqual([`/admin/api-keys/${key(1, "active", ADA).id}/expire`]),
	);
});

test("revoke every key counts active and expired keys and says revoked ones never renew", async () => {
	renderWithQuery(<ApiKeysTab />);
	await screen.findByTestId("api-keys-table");
	fireEvent.click(screen.getByTestId("api-keys-revoke-all"));
	const confirm = await screen.findByTestId("api-keys-confirm");
	expect(confirm.textContent).toContain("Revoke every API key on the site?");
	expect(confirm.textContent).toContain("This affects 3 keys");
	expect(confirm.textContent).toContain("can never be renewed");
	fireEvent.click(within(confirm).getByRole("button", { name: "Revoke 3 keys" }));
	await waitFor(() => expect(posts).toEqual(["/admin/api-keys/revoke-all"]));
});

test("an empty site says where keys come from", async () => {
	stubFetch(() => json(200, { keys: [] }));
	renderWithQuery(<ApiKeysTab />);
	expect((await screen.findByText("No API keys yet")).textContent).toBe(
		"No API keys yet",
	);
	expect(screen.queryByTestId("api-keys-table")).toBeNull();
});

test("each row's Expire and Revoke buttons are described by the key's name and its owner", async () => {
	renderWithQuery(<ApiKeysTab />);
	await screen.findByTestId("api-keys-table");
	const first = within(screen.getByTestId("admin-api-key-portikus_k1"));
	for (const name of ["Expire…", "Revoke…"]) {
		const button = first.getByRole("button", { name });
		const text = (button.getAttribute("aria-describedby") ?? "")
			.split(" ")
			.map((id) => document.getElementById(id)?.textContent)
			.join(" | ");
		expect(text).toContain("Ada Admin");
		expect(text.split(" | ")).toHaveLength(2);
	}
});

test("the tab's intro links to its administrator help topic", async () => {
	renderWithQuery(<ApiKeysTab />);
	await screen.findByTestId("api-keys-table");
	const intro = screen.getByTestId("intro-admin-api-keys");
	expect(intro.querySelector("a")?.getAttribute("href")).toBe(
		"/admin/help#admin-api-keys",
	);
});
