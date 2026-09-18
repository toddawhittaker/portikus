import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch, WORKSPACE } from "../test-utils.js";
import { CreateProjectDialog } from "./CreateProjectDialog.js";

afterEach(() => vi.unstubAllGlobals());

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
	stubFetch(() => json(200, { templates: [] }));
	open();

	expect(screen.getByTestId("slug-preview").textContent).toBe("~/projects/…");
	fireEvent.change(screen.getByTestId("field-name"), {
		target: { value: "My Todo API" },
	});
	expect(screen.getByTestId("slug-preview").textContent).toBe("~/projects/my-todo-api");
});

test("the new mode offers Git, and clone asks for a URL instead", async () => {
	stubFetch(() => json(200, { templates: [] }));
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
	stubFetch(() => json(200, { templates: [] }));
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
