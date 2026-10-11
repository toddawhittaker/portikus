import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, project, renderWithQuery, stubFetch, WORKSPACE } from "../test-utils.js";
import { isOpenShare, ShareDialog } from "./ShareDialog.js";

afterEach(() => vi.unstubAllGlobals());

const ID = "99999999-9999-4999-8999-999999999999";
const IN_A_DAY = new Date(Date.now() + 24 * 3_600_000).toISOString();
const OPEN = {
	share: { id: ID, startedAt: new Date().toISOString(), endsAt: IN_A_DAY },
	viewers: [
		{
			displayName: "Ivy Instructor",
			firstViewedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
			lastViewedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
		},
	],
	audience: [] as unknown[],
};
const AUDIENCE = [
	{
		courseId: "88888888-8888-4888-8888-888888888881",
		courseTitle: "CS 101",
		instructors: ["Ian Instructor", "Ivy Instructor"],
	},
	{
		courseId: "88888888-8888-4888-8888-888888888882",
		courseTitle: "Algorithms Lab",
		instructors: [],
	},
];
const NONE = { share: null, viewers: [], audience: AUDIENCE };

function mount(initial: unknown, calls: string[] = []) {
	let current = initial;
	stubFetch((url, init) => {
		calls.push(`${init?.method ?? "GET"} ${url}`);
		if (url.endsWith("/share/stop")) {
			current = NONE;
			return json(200, current);
		}
		if (init?.method === "POST") {
			current = OPEN;
			return json(200, current);
		}
		return json(200, current);
	});
	renderWithQuery(
		<ShareDialog workspaceId={WORKSPACE.id} project={project()} onClose={vi.fn()} />,
	);
}

test("before sharing it says who sees what and offers Start sharing", async () => {
	mount(NONE);

	const terms = await screen.findByTestId("share-terms");
	expect(terms.textContent).toContain("instructors of the courses you belong to");
	expect(terms.textContent).toContain("latest check results");
	expect(terms.textContent).toContain("terminals, previews");
	expect(screen.getByTestId("share-time").textContent).toBe(
		"24 hours, or until you stop it.",
	);
	expect(screen.getByTestId("share-start")).toBeDefined();
	expect(screen.queryByTestId("share-stop")).toBeNull();
	expect(screen.queryByTestId("share-viewers")).toBeNull();
});

test("before Start sharing it names each course and its instructors", async () => {
	mount(NONE);

	const audience = await screen.findByTestId("share-audience");
	const items = within(audience)
		.getAllByRole("listitem")
		.map((item) => item.textContent);
	expect(items).toEqual([
		"CS 101: Ian Instructor, Ivy Instructor",
		"Algorithms Lab: no instructor yet",
	]);
});

test("a student in no course is told no instructor can see it", async () => {
	mount({ ...NONE, audience: [] });

	expect((await screen.findByTestId("share-audience")).textContent).toContain(
		"You are in no course yet",
	);
});

test("starting and stopping are announced in a status that is always there", async () => {
	mount(NONE);

	const status = screen.getByTestId("share-status");
	expect(status.getAttribute("role")).toBe("status");
	expect(status.textContent).toBe("");
	fireEvent.click(await screen.findByTestId("share-start"));
	await waitFor(() => expect(status.textContent).toMatch(/^Sharing until .+\.$/));
	fireEvent.click(await screen.findByTestId("share-stop"));
	await waitFor(() => expect(status.textContent).toBe("Sharing stopped."));
	// The same node throughout: a region mounted with its text is not read out.
	expect(screen.getByTestId("share-status")).toBe(status);
});

test("a busy button stays focusable and says it is busy", async () => {
	let release: () => void = () => {};
	stubFetch((_url, init) =>
		init?.method === "POST"
			? new Promise((resolve) => {
					release = () => resolve(json(200, { ...OPEN, audience: AUDIENCE }));
				})
			: json(200, NONE),
	);
	renderWithQuery(
		<ShareDialog workspaceId={WORKSPACE.id} project={project()} onClose={vi.fn()} />,
	);

	const start = await screen.findByTestId("share-start");
	fireEvent.click(start);
	await waitFor(() => expect(start.getAttribute("aria-disabled")).toBe("true"));
	expect(start.hasAttribute("disabled")).toBe(false);
	release();
	await screen.findByTestId("share-stop");
});

test("Start sharing posts to the share route and then shows the time left", async () => {
	const calls: string[] = [];
	mount(NONE, calls);

	fireEvent.click(await screen.findByTestId("share-start"));

	await screen.findByTestId("share-stop");
	expect(calls).toContain(
		`POST /workspaces/${WORKSPACE.id}/projects/${project().id}/share`,
	);
	expect(screen.getByTestId("share-time").textContent).toContain("24 hours left");
});

test("an open share lists who looked and offers Stop sharing", async () => {
	const calls: string[] = [];
	mount(OPEN, calls);

	const viewers = await screen.findByTestId("share-viewers");
	expect(
		within(viewers).getByText("Ivy Instructor, last looked 2 minutes ago"),
	).toBeDefined();

	fireEvent.click(screen.getByTestId("share-stop"));
	await waitFor(() => expect(screen.getByTestId("share-start")).toBeDefined());
	expect(calls.some((call) => call.endsWith("/share/stop"))).toBe(true);
	expect(screen.queryByTestId("share-viewers")).toBeNull();
});

test("an open share nobody has looked at says so", async () => {
	mount({ ...OPEN, viewers: [] });

	expect((await screen.findByTestId("share-no-viewers")).textContent).toContain(
		"No instructor has looked yet",
	);
});

test("a failed start shows the error and keeps Start sharing", async () => {
	stubFetch((_url, init) =>
		init?.method === "POST"
			? json(400, {
					code: "VALIDATION_FAILED",
					message: "An archived project cannot be shared.",
				})
			: json(200, NONE),
	);
	renderWithQuery(
		<ShareDialog workspaceId={WORKSPACE.id} project={project()} onClose={vi.fn()} />,
	);

	fireEvent.click(await screen.findByTestId("share-start"));

	expect((await screen.findByTestId("dialog-error")).textContent).toContain(
		"An archived project cannot be shared.",
	);
	expect(screen.getByTestId("share-start")).toBeDefined();
});

test("isOpenShare is false without a share or once the end has passed", () => {
	const now = Date.parse("2026-10-10T12:00:00.000Z");
	expect(isOpenShare(undefined, now)).toBe(false);
	expect(isOpenShare("2026-10-10T11:59:59.000Z", now)).toBe(false);
	expect(isOpenShare("2026-10-10T12:00:01.000Z", now)).toBe(true);
});
