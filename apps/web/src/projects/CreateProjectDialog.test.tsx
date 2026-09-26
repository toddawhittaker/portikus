import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, project, renderWithQuery, stubFetch, WORKSPACE } from "../test-utils.js";
import { CreateProjectDialog } from "./CreateProjectDialog.js";

afterEach(() => vi.unstubAllGlobals());

/** Templates and both project lists, so no query in the dialog goes unanswered. */
function stubLists(projects: ReturnType<typeof project>[] = []) {
	stubFetch((url) => {
		if (url.endsWith("/templates")) return json(200, { templates: [] });
		if (url.includes("state=archived")) return json(200, { projects: [] });
		return json(200, { projects });
	});
}

function open(mode: "new" | "clone" = "new", onCreated = vi.fn()) {
	return renderWithQuery(
		<CreateProjectDialog
			workspaceId={WORKSPACE.id}
			mode={mode}
			onClose={vi.fn()}
			onCreated={onCreated}
		/>,
	);
}

test("previews the folder the project will get", async () => {
	stubLists();
	open();

	expect(screen.getByTestId("slug-preview").textContent).toBe("~/projects/…");
	fireEvent.change(screen.getByTestId("field-name"), {
		target: { value: "My Todo API" },
	});
	expect(screen.getByTestId("slug-preview").textContent).toBe("~/projects/my-todo-api");
});

test("the new mode offers Git, and clone asks for a URL instead", async () => {
	stubLists();
	open();

	expect(screen.getByTestId("field-git-init")).toBeDefined();
	expect(screen.queryByTestId("field-url")).toBeNull();

	fireEvent.click(screen.getByRole("button", { name: "Clone repository" }));

	expect(screen.getByTestId("field-url")).toBeDefined();
	expect(screen.queryByTestId("field-git-init")).toBeNull();
});

test("the template option only appears when templates are configured", async () => {
	stubFetch(() =>
		json(200, { templates: [{ name: "Starter", url: "https://x/y.git" }] }),
	);
	open();

	await screen.findByRole("button", { name: "From template" });
});

test("an API error is shown in the dialog, user sentence first", async () => {
	stubFetch((url, init) => {
		if (url.endsWith("/templates")) return json(200, { templates: [] });
		if (init?.method === undefined || init.method === "GET")
			return json(200, { projects: [] });
		if (init?.method === "POST") {
			return json(409, {
				code: "PROJECT_EXISTS",
				message: "A project called todo-api already exists.",
			});
		}
		throw new Error(`unexpected ${url}`);
	});
	open();

	fireEvent.change(screen.getByTestId("field-name"), { target: { value: "todo-api" } });
	fireEvent.click(screen.getByRole("button", { name: "Create project" }));

	const error = await screen.findByTestId("dialog-error");
	expect(error.textContent).toContain("A project called todo-api already exists.");
	expect(error.textContent).toContain("PROJECT_EXISTS");
});

test("pasting a clone URL fills the name and slug, and editing the name wins", async () => {
	stubLists();
	open("clone");

	fireEvent.change(screen.getByTestId("field-url"), {
		target: { value: "https://github.com/user/todo-api.git" },
	});
	expect((screen.getByTestId("field-name") as HTMLInputElement).value).toBe("todo-api");
	expect(screen.getByTestId("slug-preview").textContent).toBe("~/projects/todo-api");

	fireEvent.change(screen.getByTestId("field-name"), { target: { value: "My Work" } });
	fireEvent.change(screen.getByTestId("field-url"), {
		target: { value: "https://github.com/user/other.git" },
	});
	expect((screen.getByTestId("field-name") as HTMLInputElement).value).toBe("My Work");
});

test("a GitHub URL without .git is sent with the suffix", async () => {
	const sent: string[] = [];
	stubFetch((url, init) => {
		if (url.endsWith("/templates")) return json(200, { templates: [] });
		if (init?.method === undefined || init.method === "GET")
			return json(200, { projects: [] });
		if (init?.method === "POST") {
			sent.push(JSON.parse(String(init.body)).url);
			return json(201, {});
		}
		throw new Error(`unexpected ${url}`);
	});
	open("clone");

	fireEvent.change(screen.getByTestId("field-url"), {
		target: { value: "https://github.com/user/todo-api" },
	});
	const form = screen.getByTestId("field-url").closest("form") as HTMLFormElement;
	fireEvent.submit(form);

	await waitFor(() => expect(sent).toEqual(["https://github.com/user/todo-api.git"]));
});

test("cloning reports progress on the button and hands back the project", async () => {
	const created = {
		id: "44444444-4444-4444-8444-444444444444",
		workspaceId: WORKSPACE.id,
		slug: "repo",
		name: "repo",
		path: "/home/student/projects/repo",
		state: "active",
		source: "clone",
		isGitRepo: true,
		missing: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		archivedAt: null,
	};
	stubFetch((url, init) => {
		if (url.endsWith("/templates")) return json(200, { templates: [] });
		if (init?.method !== "POST") return json(200, { projects: [] });
		if (init?.method === "POST") return json(201, created);
		throw new Error(`unexpected ${url}`);
	});
	const onCreated = vi.fn();
	open("clone", onCreated);

	fireEvent.change(screen.getByTestId("field-name"), { target: { value: "repo" } });
	fireEvent.change(screen.getByTestId("field-url"), {
		target: { value: "https://example.invalid/repo.git" },
	});
	// Submitting the form is what Enter in the name field does.
	const form = screen.getByTestId("field-name").closest("form") as HTMLFormElement;
	fireEvent.submit(form);

	await waitFor(() => expect(onCreated).toHaveBeenCalled());
	expect(onCreated.mock.calls[0]?.[0]).toEqual(created);
});

test("warns while the typed name would clash with an existing project", async () => {
	stubLists([project({ slug: "todo-api", name: "todo-api" })]);
	open();

	fireEvent.change(screen.getByTestId("field-name"), { target: { value: "Todo API" } });

	const warning = await screen.findByTestId("name-clash");
	expect(warning.textContent).toBe("A project called todo-api already exists");
	expect((screen.getByTestId("dialog-confirm") as HTMLButtonElement).disabled).toBe(
		true,
	);

	fireEvent.change(screen.getByTestId("field-name"), {
		target: { value: "Todo API 2" },
	});

	await waitFor(() => expect(screen.queryByTestId("name-clash")).toBeNull());
	expect((screen.getByTestId("dialog-confirm") as HTMLButtonElement).disabled).toBe(
		false,
	);
});

test("an archived project still holds its folder, so its slug clashes", async () => {
	stubFetch((url) => {
		if (url.endsWith("/templates")) return json(200, { templates: [] });
		if (url.includes("state=archived"))
			return json(200, {
				projects: [project({ slug: "old-lab", name: "old-lab", state: "archived" })],
			});
		return json(200, { projects: [] });
	});
	open();

	fireEvent.change(screen.getByTestId("field-name"), { target: { value: "Old Lab" } });

	expect((await screen.findByTestId("name-clash")).textContent).toBe(
		"A project called old-lab already exists",
	);
});

test("a name filled from a clone URL warns about a clash too", async () => {
	stubLists([project({ slug: "todo-api", name: "todo-api" })]);
	open("clone");

	fireEvent.change(screen.getByTestId("field-url"), {
		target: { value: "https://github.com/user/todo-api.git" },
	});

	await screen.findByTestId("name-clash");
	expect((screen.getByTestId("dialog-confirm") as HTMLButtonElement).disabled).toBe(
		true,
	);
});

/** Issue #608 item 5: one segmented control, exactly one option pressed. */
test("What to create is a segmented control with one pressed option", async () => {
	stubLists();
	open();

	const group = screen.getByRole("group", { name: "What to create" });
	expect(group.classList.contains("pk-segmented")).toBe(true);
	const pressed = () =>
		Array.from(group.querySelectorAll("button")).filter(
			(button) => button.getAttribute("aria-pressed") === "true",
		);
	expect(pressed().map((button) => button.textContent)).toEqual(["New project"]);

	fireEvent.click(screen.getByRole("button", { name: "Clone repository" }));
	expect(pressed().map((button) => button.textContent)).toEqual(["Clone repository"]);
});
