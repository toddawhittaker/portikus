import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { EditorSchemeSelect } from "./EditorSchemeSelect.js";

afterEach(cleanup);

test("the select shows the chosen scheme by its label", () => {
	render(
		<EditorSchemeSelect
			label="Editor color scheme"
			value="vscode"
			onChange={() => {}}
		/>,
	);
	expect(screen.getByLabelText("Editor color scheme").textContent).toContain("VS Code");
});
