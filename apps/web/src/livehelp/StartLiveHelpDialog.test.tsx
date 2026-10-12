import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "../api/request.js";
import { json, project, renderWithQuery, stubFetch, WORKSPACE } from "../test-utils.js";
import {
	instructorGroups,
	StartLiveHelpDialog,
	startError,
} from "./StartLiveHelpDialog.js";

afterEach(() => vi.unstubAllGlobals());

const COURSE = "88888888-8888-4888-8888-888888888881";
const OTHER_COURSE = "88888888-8888-4888-8888-888888888882";
const IVY = "77777777-7777-4777-8777-777777777771";
const IAN = "77777777-7777-4777-8777-777777777772";
const ONE = [
	{
		courseId: COURSE,
		courseTitle: "CS 101",
		instructors: [{ userId: IVY, displayName: "Ivy Instructor" }],
	},
	{ courseId: OTHER_COURSE, courseTitle: "Algorithms Lab", instructors: [] },
];
const SESSION = {
	id: "99999999-9999-4999-8999-999999999999",
	projectId: project().id,
	projectName: "todo-api",
	courseId: COURSE,
	helper: { userId: IVY, displayName: "Ivy Instructor" },
	typing: false,
	startedAt: new Date().toISOString(),
	endsAt: new Date(Date.now() + 3_600_000).toISOString(),
};

function mount(
	audience: unknown[],
	answer: (body: unknown) => Response = () => json(200, { session: SESSION, audience }),
	session: unknown = null,
) {
	const calls: { method: string; url: string; body: unknown }[] = [];
	const onClose = vi.fn();
	stubFetch((url, init) => {
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ method: init?.method ?? "GET", url, body });
		if (init?.method === "POST") return answer(body);
		return json(200, { session, audience });
	});
	renderWithQuery(
		<StartLiveHelpDialog
			workspaceId={WORKSPACE.id}
			project={project()}
			onClose={onClose}
		/>,
	);
	return { calls, onClose };
}

test("the consent text says what they see, that typing is off, and what typing gives them", async () => {
	mount(ONE);
	const terms = await screen.findByTestId("live-help-terms");
	expect(terms.textContent).toContain("terminals of todo-api and its previews");
	expect(terms.textContent).toContain("Off. They can only watch");
	expect(terms.textContent).toContain("Only you can turn typing on or off");
	expect(screen.getByTestId("live-help-typing-risk").textContent).toContain(
		"full shell as you. That includes your Git, Claude and SSH credentials",
	);
	expect(screen.getByTestId("live-help-typing-risk").textContent).toContain(
		"your other terminals",
	);
	expect(terms.textContent).toContain("At most 60 minutes");
});

test("a single instructor is chosen already and Start sends them with their course", async () => {
	const { calls, onClose } = mount(ONE);
	await screen.findByTestId("live-help-terms");
	expect(
		screen.getByRole("combobox", { name: /Who should help/ }).textContent,
	).toContain("Ivy Instructor");
	fireEvent.click(screen.getByTestId("live-help-start"));
	await waitFor(() => expect(onClose).toHaveBeenCalled());
	const post = calls.find((call) => call.method === "POST");
	expect(post?.url).toBe(
		`/workspaces/${WORKSPACE.id}/projects/${project().id}/live-help`,
	);
	expect(post?.body).toEqual({ courseId: COURSE, helperUserId: IVY });
});

test("with two instructors Start waits for a choice and says why", async () => {
	const { calls } = mount([
		{
			courseId: COURSE,
			courseTitle: "CS 101",
			instructors: [
				{ userId: IVY, displayName: "Ivy Instructor" },
				{ userId: IAN, displayName: "Ian Instructor" },
			],
		},
	]);
	const start = await screen.findByTestId("live-help-start");
	expect(start.getAttribute("aria-disabled")).toBe("true");
	expect(start.getAttribute("aria-describedby")).toBe("live-help-instructor-hint");
	expect(document.getElementById("live-help-instructor-hint")?.textContent).toBe(
		"Choose an instructor first.",
	);
	fireEvent.click(start);
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(calls.some((call) => call.method === "POST")).toBe(false);
});

test("with no instructor in any course it says so and offers no Start", async () => {
	mount([{ courseId: OTHER_COURSE, courseTitle: "Algorithms Lab", instructors: [] }]);
	expect((await screen.findByTestId("live-help-no-instructors")).textContent).toContain(
		"no one to ask",
	);
	expect(screen.queryByTestId("live-help-start")).toBeNull();
	// The footer's Close and the title bar's close button.
	expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(2);
});

test("an open session is named and no second one can start", async () => {
	mount(ONE, undefined, SESSION);
	expect((await screen.findByTestId("live-help-already-open")).textContent).toContain(
		"Live help with Ivy Instructor on todo-api is already open",
	);
	expect(screen.queryByTestId("live-help-start")).toBeNull();
});

test("a refusal because the instructor no longer teaches the course says to choose again", async () => {
	mount(ONE, () =>
		json(400, {
			code: "VALIDATION_FAILED",
			message: "That person does not teach that course of yours.",
		}),
	);
	fireEvent.click(await screen.findByTestId("live-help-start"));
	const error = await screen.findByTestId("dialog-error");
	expect(error.textContent).toContain(
		"That person does not teach that course of yours.",
	);
	expect(error.textContent).toContain("choose an instructor from it");
});

test("instructorGroups keeps only courses with an instructor, keyed by course and person", () => {
	expect(instructorGroups(ONE)).toEqual([
		{
			label: "CS 101",
			options: [{ value: `${COURSE}/${IVY}`, label: "Ivy Instructor" }],
		},
	]);
});

test("startError rewords an open session and leaves other errors alone", () => {
	const open = startError(new ApiError(409, "x", "LIVE_HELP_OPEN")) as ApiError;
	expect(open.message).toContain("End it from the bar at the top of the page");
	const other = new ApiError(500, "Broken", "INTERNAL");
	expect(startError(other)).toBe(other);
	expect(startError(null)).toBeNull();
});
