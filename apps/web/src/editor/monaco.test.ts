import { expect, test, vi } from "vitest";
import { accessibilitySupport, editorAriaLabel } from "./monaco.js";

vi.mock("./features.js", () => ({ loadEditorFeatures: async () => {} }));

/**
 * "off" would make Monaco name its text box "The editor is not accessible at
 * this time." and drop the file name, so the setting's off is "auto"
 * (SPEC.md §25.8).
 */
test("screen-reader mode forces support on, and off leaves it to Monaco", () => {
	expect(accessibilitySupport(true)).toBe("on");
	expect(accessibilitySupport(false)).toBe("auto");
});

test("the editor's name says which file and how Tab leaves it", () => {
	expect(editorAriaLabel("Editor", "src/app.ts")).toBe(
		"Editor, src/app.ts. Ctrl+M makes Tab leave the editor.",
	);
});
