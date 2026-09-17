import { fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, project, renderWithQuery, stubFetch, WORKSPACE } from "../test-utils.js";
import { RenameDialog } from "./RenameDialog.js";

afterEach(() => vi.unstubAllGlobals());

test("shows the folder the project will move to and says so", () => {
	stubFetch(() => json(200, {}));
	renderWithQuery(
		<RenameDialog
			workspaceId={WORKSPACE.id}
			project={project()}
			onClose={vi.fn()}
			onRenamed={vi.fn()}
		/>,
	);

	expect(screen.getByTestId("slug-preview").textContent).toBe("~/projects/todo-api");
	expect(screen.getByText("The folder is renamed too.")).toBeDefined();

	fireEvent.change(screen.getByTestId("field-name"), {
		target: { value: "Todo API v2" },
	});
	expect(screen.getByTestId("slug-preview").textContent).toBe("~/projects/todo-api-v2");
});
