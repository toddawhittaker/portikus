import type { ActiveCourseMember, CourseMember } from "@portikus/contracts";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ClassDots, ClassDotsKey, dotCounts } from "./ClassDots.js";

function student(
	userId: string,
	workspaceState: ActiveCourseMember["workspaceState"],
): ActiveCourseMember {
	return {
		userId,
		displayName: `Student ${userId}`,
		role: "student",
		status: "active",
		lastLaunchAt: "2026-11-12T10:00:00.000Z",
		workspaceState,
	};
}

const CLASS = [
	student("a", "running"),
	student("b", "running"),
	student("c", "stopped"),
	student("d", "running"),
];

test("the key names each kind of dot shown, in the dots' order, and nothing else", () => {
	render(<ClassDotsKey students={CLASS} waiting={new Set(["d"])} />);
	const key = screen.getByTestId("class-dots-key");
	expect([...key.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
		"Waiting for help",
		"Running",
		"Stopped",
	]);
	// The sentence above carries the figures, so the key stays out of the reading order.
	expect(key.getAttribute("aria-hidden")).toBe("true");
});

test("a waiting student's dot is amber even while their workspace runs", () => {
	const { container } = render(<ClassDots students={CLASS} waiting={new Set(["d"])} />);
	const kinds = [...container.querySelectorAll(".pk-class-dot")].map((dot) =>
		dot.getAttribute("data-kind"),
	);
	expect(kinds).toEqual(["waiting", "running", "running", "stopped"]);
});

test("a student with no workspace and one starting each get a key entry of their own", () => {
	render(
		<ClassDotsKey
			students={[student("a", null), student("b", "starting")]}
			waiting={new Set()}
		/>,
	);
	expect(
		[...screen.getByTestId("class-dots-key").querySelectorAll("li")].map(
			(item) => item.textContent,
		),
	).toEqual(["Starting or stopping", "No workspace yet"]);
});

test("the counts group the class as the dots do, every kind with any student", () => {
	const notStarted: CourseMember = {
		status: "not_started",
		userId: null,
		displayName: "Nia New",
		role: "student",
		lastLaunchAt: null,
		workspaceState: null,
	};
	const students: CourseMember[] = [
		...CLASS,
		student("e", "starting"),
		student("f", "error"),
		notStarted,
	];
	// d is waiting, so it counts once, as waiting, not also as running.
	expect(dotCounts(students, new Set(["d"]))).toEqual([
		{ kind: "waiting", count: 1, text: "1 waiting for help" },
		{ kind: "error", count: 1, text: "1 workspace error" },
		{ kind: "running", count: 2, text: "2 running" },
		{ kind: "moving", count: 1, text: "1 starting or stopping" },
		{ kind: "stopped", count: 1, text: "1 stopped" },
		{ kind: "none", count: 1, text: "1 with no workspace yet" },
	]);
	expect(dotCounts(CLASS, new Set()).map((group) => group.kind)).toEqual([
		"running",
		"stopped",
	]);
});
