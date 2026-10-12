import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch, WORKSPACE } from "../test-utils.js";
import { LiveHelpBar, liveHelpChange } from "./LiveHelpBar.js";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

const SESSION = {
	id: "99999999-9999-4999-8999-999999999999",
	projectId: "66666666-6666-4666-8666-666666666666",
	projectName: "demo",
	courseId: "88888888-8888-4888-8888-888888888881",
	helper: {
		userId: "77777777-7777-4777-8777-777777777771",
		displayName: "Ivy Instructor",
	},
	typing: false,
	startedAt: new Date().toISOString(),
	endsAt: new Date(Date.now() + 45 * 60_000).toISOString(),
};

function mount(initial: unknown) {
	let session = initial as typeof SESSION | null;
	const calls: string[] = [];
	stubFetch((url, init) => {
		calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`.trim());
		if (url.endsWith("/typing")) {
			const { typing } = JSON.parse(String(init?.body));
			if (session) session = { ...session, typing };
		}
		if (url.endsWith("/stop")) session = null;
		return json(200, { session, audience: [] });
	});
	const client = renderWithQuery(<LiveHelpBar workspaceId={WORKSPACE.id} />);
	return {
		calls,
		client,
		set: (next: typeof SESSION | null) => {
			session = next;
		},
	};
}

test("with nothing open there is no bar, only the empty status region", async () => {
	const { calls } = mount(null);
	await waitFor(() =>
		expect(calls).toContain(`GET /workspaces/${WORKSPACE.id}/live-help`),
	);
	expect(screen.queryByTestId("live-help-bar")).toBeNull();
	expect(screen.getByTestId("live-help-announce").textContent).toBe("");
});

test("the bar names the instructor and project, says typing is off, and shows the time left", async () => {
	mount(SESSION);
	const bar = await screen.findByTestId("live-help-bar");
	expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
		"Live help with Ivy Instructor",
	);
	expect(bar.textContent).toContain("terminals and previews of demo");
	expect(bar.textContent).toContain("They cannot type.");
	expect(screen.getByTestId("live-help-time").textContent).toMatch(
		/^4[45] minutes left$/,
	);
	expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull();
	// An open session already there on load is not announced.
	expect(screen.getByTestId("live-help-announce").textContent).toBe("");
});

test("Let them type turns typing on, announces it, and becomes Stop typing", async () => {
	const { calls } = mount(SESSION);
	fireEvent.click(await screen.findByRole("button", { name: "Let them type" }));
	await screen.findByRole("button", { name: "Stop typing" });
	expect(calls).toContain(
		`POST /workspaces/${WORKSPACE.id}/live-help/typing {"typing":true}`,
	);
	expect(screen.getByTestId("live-help-bar").className).toContain("is-typing");
	expect(screen.getByTestId("live-help-summary").textContent).toContain(
		"full shell as you",
	);
	expect(screen.getByTestId("live-help-announce").textContent).toBe(
		"Ivy Instructor can now type in your terminals.",
	);
	fireEvent.click(screen.getByRole("button", { name: "Stop typing" }));
	await screen.findByRole("button", { name: "Let them type" });
	expect(screen.getByTestId("live-help-announce").textContent).toBe(
		"Ivy Instructor can no longer type. They can only watch.",
	);
});

test("End live help ends it, removes the bar and says the student ended it", async () => {
	const { calls } = mount(SESSION);
	fireEvent.click(await screen.findByRole("button", { name: "End live help" }));
	await waitFor(() => expect(screen.queryByTestId("live-help-bar")).toBeNull());
	expect(calls).toContain(`POST /workspaces/${WORKSPACE.id}/live-help/stop`);
	expect(screen.getByTestId("live-help-announce").textContent).toBe(
		"You ended live help with Ivy Instructor.",
	);
});

test("a session started elsewhere appears on the next poll and is announced", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	const { set } = mount(null);
	await waitFor(() => expect(screen.getByTestId("live-help-announce")).toBeTruthy());
	set(SESSION);
	await act(() => vi.advanceTimersByTimeAsync(31_000));
	await screen.findByTestId("live-help-bar");
	expect(screen.getByTestId("live-help-announce").textContent).toContain(
		"Live help started. Ivy Instructor can see the terminals and previews of demo.",
	);
});

test("an end from the other side shows within one five-second poll", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	const { set } = mount(SESSION);
	await screen.findByTestId("live-help-bar");
	set(null);
	await act(() => vi.advanceTimersByTimeAsync(5_100));
	await waitFor(() => expect(screen.queryByTestId("live-help-bar")).toBeNull());
	expect(screen.getByTestId("live-help-announce").textContent).toContain(
		"Live help with Ivy Instructor ended. They left",
	);
});

test("liveHelpChange says why a session ended", () => {
	const now = Date.now();
	const ending = { ...SESSION, endsAt: new Date(now).toISOString() };
	expect(liveHelpChange(SESSION, null, true, now)).toBe(
		"You ended live help with Ivy Instructor.",
	);
	expect(liveHelpChange(ending, null, false, now)).toBe(
		"Live help with Ivy Instructor ended because its time ran out.",
	);
	expect(liveHelpChange(SESSION, null, false, now)).toContain("They left");
	expect(liveHelpChange(SESSION, SESSION, false, now)).toBeNull();
	expect(liveHelpChange(null, null, false, now)).toBeNull();
	expect(liveHelpChange(null, SESSION, false, now)).toContain("Typing is off.");
});
