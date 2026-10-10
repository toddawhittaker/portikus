import type { AdminUser, AdminWorkspaceSummary } from "@portikus/contracts";
import { screen } from "@testing-library/react";
import { json, renderApp, stubFetch } from "../../test-utils.js";

/** Shared rows and stubs for the Users tab's tests. */

export const NONE = {
	disabled: false,
	archived: false,
	duplicateEmail: false,
	stale: false,
	notSignedInYet: false,
	linked: false,
};

export function summary(
	overrides: Partial<AdminWorkspaceSummary> = {},
): AdminWorkspaceSummary {
	return {
		id: "22222222-2222-4222-8222-222222222222",
		label: "alice",
		state: "running",
		desiredState: "running",
		activeConnections: 0,
		lastActiveConnectionAt: null,
		quotaConfig: { homeGiB: 25, dockerGiB: 20 },
		quotaApplied: { homeGiB: 25, dockerGiB: 20 },
		image: { label: "2026.09.9", fingerprint: "abc", current: true },
		archivedAt: null,
		pendingOperation: null,
		cpuThrottle: null,
		memoryFlag: null,
		...overrides,
	};
}

export function account(
	displayName: string,
	workspace: AdminWorkspaceSummary | null,
	extra: Partial<AdminUser> = {},
): AdminUser {
	return {
		id: `${displayName}-id`,
		displayName,
		email: `${displayName.toLowerCase()}@example.edu`,
		role: "student",
		providerRole: "student",
		grantedRole: null,
		disabledAt: null,
		shutdownGraceSeconds: null,
		dexLocal: false,
		preferredUsername: displayName.toLowerCase(),
		issuer: null,
		lastLoginAt: null,
		markers: NONE,
		workspace,
		...extra,
	};
}

// Rendered tests: rows need real ids to pass the contract.
export function uuid(n: number): string {
	return `0000000${n}-0000-4000-8000-000000000000`;
}

export const ADMIN_ME = {
	id: uuid(9),
	email: "carol@example.invalid",
	displayName: "Carol Admin",
	role: "administrator" as const,
	mustChangePassword: false,
	mustAcceptUse: false,
	localPassword: false,
	secondFactor: null,
};

export function listed(
	n: number,
	displayName: string,
	extra: Partial<AdminUser> = {},
): AdminUser {
	return account(displayName, null, { id: uuid(n), ...extra });
}

export const ROWS = [
	listed(1, "Alice Example", {
		workspace: summary({ id: uuid(5), label: "alice", activeConnections: 2 }),
		issuer: "https://login.example.edu",
	}),
	listed(2, "Bob Student", {
		workspace: summary({
			id: uuid(6),
			label: "bob",
			image: { label: "2026.09.8", fingerprint: "old", current: false },
		}),
		issuer: "https://login.example.edu",
	}),
	listed(3, "Sam Course", {
		issuer: "lti:https://canvas.example.edu",
		email: null,
		preferredUsername: "sam7",
	}),
	listed(9, "Carol Admin", { role: "administrator", providerRole: "administrator" }),
	listed(4, "Gina Granted", {
		role: "administrator",
		grantedRole: "administrator",
		disabledAt: "2026-09-01T00:00:00.000Z",
		markers: { ...NONE, disabled: true },
	}),
];

/** Answers the list; POSTs land in `writes`, and a URL in `refuse` answers 400. */
export function stubUsers(refuse: Record<string, string> = {}) {
	const writes: string[] = [];
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, ADMIN_ME);
		if (isUsersList(url)) return usersBody(url, ROWS, false);
		if (url === "/admin/settings") {
			return json(200, { shutdownGraceSeconds: 600, logLevel: null, updatedAt: null });
		}
		if (init?.method === "POST") {
			writes.push(url);
			const message = refuse[url];
			if (message) return json(400, { code: "VALIDATION_FAILED", message });
			return json(204, null);
		}
		throw new Error(`unexpected request: ${url}`);
	});
	return writes;
}

export async function openTable() {
	renderApp("/admin");
	await screen.findByTestId(`account-row-${uuid(1)}`);
}

/** True for the Users list URL, with or without the paging query. */
export function isUsersList(url: string): boolean {
	return url === "/admin/users" || url.startsWith("/admin/users?");
}

/**
 * What the server answers for a Users list URL: the query's filters, then
 * its page, as a response. A small stand-in for the API, which has its own tests.
 */
export function usersBody(url: string, all: readonly unknown[], dexUsers = false) {
	const rows = all as AdminUser[];
	const query = new URLSearchParams(url.split("?")[1] ?? "");
	const needle = (query.get("q") ?? "").toLowerCase();
	const pendingOnly = query.get("pending") === "1";
	const matching = rows.filter((user) => {
		if (pendingOnly) return Boolean(user.workspace?.pendingOperation);
		if (!query.has("archived") && user.markers.archived) return false;
		const role = query.get("role");
		if (role && user.role !== role) return false;
		const state = query.get("state");
		if (state === "none" && user.workspace) return false;
		if (state && state !== "none" && user.workspace?.state !== state) return false;
		const image = query.get("image");
		const current = user.workspace?.image.current;
		if (image === "current" && current !== true) return false;
		if (image === "older" && current !== false) return false;
		return (
			needle === "" ||
			[user.displayName, user.email, user.preferredUsername, user.issuer].some(
				(field) => field?.toLowerCase().includes(needle),
			)
		);
	});
	// Only the two orders the tests press; the API has the full set.
	const byName = [...matching].sort((x, y) =>
		x.displayName.localeCompare(y.displayName),
	);
	if (query.get("sort") === "activity") {
		const connections = (user: AdminUser) => user.workspace?.activeConnections ?? 0;
		byName.sort((x, y) => connections(y) - connections(x));
	}
	if (query.get("sort") === "account" && query.get("dir") === "descending") {
		byName.reverse();
	}
	const offset = Number(query.get("offset") ?? 0);
	const limit = query.has("limit") ? Number(query.get("limit")) : undefined;
	return json(200, {
		users: byName.slice(offset, limit === undefined ? undefined : offset + limit),
		total: matching.length,
		dexUsers,
	});
}
