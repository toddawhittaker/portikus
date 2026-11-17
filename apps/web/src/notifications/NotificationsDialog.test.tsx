import type { Notification } from "@portikus/contracts";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../test-utils.js";
import { NotificationsDialog } from "./NotificationsDialog.js";

// SPEC.md sections 8.5 and 20.5.
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function note(overrides: Partial<Notification>): Notification {
	return {
		id: crypto.randomUUID(),
		tone: "warning",
		title: "Disk is filling",
		body: "",
		createdAt: new Date().toISOString(),
		readAt: null,
		...overrides,
	};
}

function show(...items: Notification[]) {
	stubFetch(() => json(200, { notifications: items, unreadCount: items.length }));
	renderWithQuery(<NotificationsDialog onClose={() => {}} />);
}

test("an alert's explanation shows under it, labelled as written by AI", async () => {
	show(note({ body: "Pool at 91%", triage: "Old snapshots are likely the cause." }));
	const triage = await screen.findByTestId("notification-triage");
	// A visible line says who wrote it; there is no landmark to read it twice (WCAG 1.3.1).
	expect(triage.getAttribute("aria-label")).toBeNull();
	expect(triage.tagName).toBe("DIV");
	expect(screen.queryByRole("region")).toBeNull();
	expect(within(triage).getByText(/^Explanation written by AI/)).toBeTruthy();
	expect(triage.textContent).toContain("Old snapshots are likely the cause.");
	// It comes after the body, inside the same notification.
	const item = screen.getByTestId("notification");
	expect(item.textContent?.indexOf("Pool at 91%")).toBeLessThan(
		item.textContent?.indexOf("Old snapshots") ?? -1,
	);
});

test("the explanation is plain text: markup and Markdown are shown as typed", async () => {
	const hostile =
		'<script id="x">alert(1)</script> **bold** <img src=x onerror=alert(1)>';
	show(note({ triage: hostile }));
	const triage = await screen.findByTestId("notification-triage");
	expect(triage.querySelector("script, img, strong, b")).toBeNull();
	expect(within(triage).getByText(hostile)).toBeTruthy();
});

test("a notification without an explanation has no block", async () => {
	show(note({ body: "Pool at 91%" }));
	await screen.findByTestId("notification");
	expect(screen.queryByTestId("notification-triage")).toBeNull();
});

test("a body keeps its line breaks, as the weekly digest needs", async () => {
	const digest = "Health: 99%\nPeak: 12 of 20\nUsage: $4";
	show(note({ tone: "neutral", title: "Weekly digest", body: digest }));
	const item = await screen.findByTestId("notification");
	const body = within(item).getByText(
		(_, element) => element?.tagName === "P" && element.textContent === digest,
	);
	expect(body.className).toContain("whitespace-pre-line");
});
