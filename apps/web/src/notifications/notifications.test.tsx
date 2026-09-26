import type { Notification } from "@portikus/contracts";
import { ToastProvider, useToast } from "@portikus/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "../api/queryClient.js";
import { badgeText } from "../shell/AppHeader.js";
import { json, renderWithQuery, stubFetch } from "../test-utils.js";
import { NotificationsDialog, relativeTime } from "./NotificationsDialog.js";
import { recordNotification } from "./queries.js";

// SPEC.md section 8.5.
afterEach(() => {
	vi.unstubAllGlobals();
});

const NOW = Date.now();

function note(overrides: Partial<Notification>): Notification {
	return {
		id: crypto.randomUUID(),
		tone: "neutral",
		title: "Saved",
		body: "",
		createdAt: new Date(NOW - 5 * 60_000).toISOString(),
		readAt: null,
		...overrides,
	};
}

test("the badge shows the count, 9+ above nine, and nothing at zero", () => {
	expect(badgeText(0)).toBeNull();
	expect(badgeText(1)).toBe("1");
	expect(badgeText(9)).toBe("9");
	expect(badgeText(10)).toBe("9+");
});

test("relative time reads in plain words", () => {
	expect(relativeTime(new Date(NOW).toISOString(), NOW)).toBe("Just now");
	expect(relativeTime(new Date(NOW - 4 * 60_000).toISOString(), NOW)).toBe("4 min ago");
	expect(relativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe(
		"3 h ago",
	);
	expect(relativeTime(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe(
		"2 days ago",
	);
});

test("the dialog lists newest first, marks unread, and opening it marks nothing read", async () => {
	const fetchMock = stubFetch(() =>
		json(200, {
			notifications: [
				note({ title: "Newest", tone: "danger", body: "It broke" }),
				note({ title: "Older", readAt: new Date(NOW).toISOString() }),
			],
			unreadCount: 1,
		}),
	);
	renderWithQuery(<NotificationsDialog onClose={() => {}} />);

	const items = await screen.findAllByTestId("notification");
	expect(items.map((item) => item.dataset.unread)).toEqual(["true", "false"]);
	expect(items[0]?.textContent).toContain("Unread. Error: Newest");
	expect(items[0]?.textContent).toContain("It broke");
	expect(items[0]?.textContent).toContain("5 min ago");
	expect(screen.getByText("1 unread notification.")).toBeDefined();
	expect(
		fetchMock.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET"),
	).toBe(true);
});

test("mark read, mark all as read, and clear call their routes", async () => {
	const first = note({ title: "One" });
	const fetchMock = stubFetch((_url, init) => {
		const method = init?.method ?? "GET";
		if (method === "GET") return json(200, { notifications: [first], unreadCount: 1 });
		if (method === "PATCH")
			return json(200, { ...first, readAt: new Date().toISOString() });
		return json(204, null);
	});
	renderWithQuery(<NotificationsDialog onClose={() => {}} />);

	fireEvent.click(await screen.findByRole("button", { name: 'Mark read: "One"' }));
	await waitFor(() =>
		expect(fetchMock).toHaveBeenCalledWith(
			`/me/notifications/${first.id}`,
			expect.objectContaining({
				method: "PATCH",
				body: JSON.stringify({ read: true }),
			}),
		),
	);
	fireEvent.click(screen.getByTestId("notifications-read-all"));
	await waitFor(() =>
		expect(fetchMock).toHaveBeenCalledWith(
			"/me/notifications/read-all",
			expect.objectContaining({ method: "POST" }),
		),
	);
	fireEvent.click(screen.getByTestId("notifications-clear"));
	await waitFor(() =>
		expect(fetchMock).toHaveBeenCalledWith(
			"/me/notifications",
			expect.objectContaining({ method: "DELETE" }),
		),
	);
});

test("after Mark read, focus moves to the next Mark read, then to Mark all as read", async () => {
	const items = [note({ title: "One" }), note({ title: "Two" })];
	stubFetch((url, init) => {
		const method = init?.method ?? "GET";
		if (method === "PATCH") {
			const id = String(url).split("/").pop();
			const item = items.find((entry) => entry.id === id);
			if (item) item.readAt = new Date().toISOString();
			return json(200, item);
		}
		return json(200, {
			notifications: items.map((item) => ({ ...item })),
			unreadCount: items.filter((item) => item.readAt === null).length,
		});
	});
	renderWithQuery(<NotificationsDialog onClose={() => {}} />);

	fireEvent.click(await screen.findByRole("button", { name: 'Mark read: "One"' }));
	await waitFor(() =>
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: 'Mark read: "Two"' }),
		),
	);
	fireEvent.click(screen.getByRole("button", { name: 'Mark read: "Two"' }));
	const readAll = screen.getByTestId("notifications-read-all");
	await waitFor(() => expect(document.activeElement).toBe(readAll));
	// Still focusable, and says it has nothing to do.
	expect(readAll.getAttribute("aria-disabled")).toBe("true");
	expect(readAll.hasAttribute("disabled")).toBe(false);
});

test("an empty history says so", async () => {
	stubFetch(() => json(200, { notifications: [], unreadCount: 0 }));
	renderWithQuery(<NotificationsDialog onClose={() => {}} />);
	expect(await screen.findByTestId("notifications-empty")).toBeDefined();
});

function Raise() {
	const toast = useToast();
	return (
		<button
			type="button"
			onClick={() => toast.show({ tone: "warning", title: "Disk nearly full" })}
		>
			Raise
		</button>
	);
}

test("each toast shown records one notification", async () => {
	const fetchMock = stubFetch(() => json(201, {}));
	const client = createQueryClient(() => {});
	render(
		<QueryClientProvider client={client}>
			<ToastProvider onShow={(toast) => void recordNotification(client, toast)}>
				<Raise />
			</ToastProvider>
		</QueryClientProvider>,
	);
	fireEvent.click(screen.getByText("Raise"));
	expect(screen.getByText("Disk nearly full")).toBeDefined();
	await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
	const [url, init] = fetchMock.mock.calls[0] ?? [];
	expect(url).toBe("/me/notifications");
	expect(JSON.parse(String(init?.body))).toEqual({
		tone: "warning",
		title: "Disk nearly full",
		body: "",
	});
});

test("a failed record is dropped: no retry, no second toast, the toast stays", async () => {
	const fetchMock = vi.fn(async () => {
		throw new TypeError("Failed to fetch");
	});
	vi.stubGlobal("fetch", fetchMock);
	const client = createQueryClient(() => {});
	render(
		<QueryClientProvider client={client}>
			<ToastProvider onShow={(toast) => void recordNotification(client, toast)}>
				<Raise />
			</ToastProvider>
		</QueryClientProvider>,
	);
	fireEvent.click(screen.getByText("Raise"));
	await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(screen.getAllByText("Disk nearly full")).toHaveLength(1);
	expect(screen.queryAllByRole("alert")).toHaveLength(1);
});
