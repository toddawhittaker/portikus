import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FieldMessages, fieldDescribedBy } from "./FieldMessages.js";

describe("fieldDescribedBy", () => {
	it("is undefined with no messages", () => {
		expect(fieldDescribedBy({ id: "f" })).toBeUndefined();
	});

	it("lists the hint before the error (SPEC.md section 25.8)", () => {
		expect(fieldDescribedBy({ id: "f", hint: "h", error: "e" })).toBe("f-hint f-err");
	});

	it("lists the warning only when there is no error", () => {
		expect(fieldDescribedBy({ id: "f", hint: "h", warning: "w" })).toBe(
			"f-hint f-warn",
		);
		expect(fieldDescribedBy({ id: "f", error: "e", warning: "w" })).toBe("f-err");
	});
});

describe("FieldMessages", () => {
	it("renders an element for every id fieldDescribedBy names, and nothing else", () => {
		const props = { id: "f", hint: "Hint.", error: "Error.", warning: "Warn." };
		const { container } = render(<FieldMessages {...props} />);
		const ids = fieldDescribedBy(props)?.split(" ") ?? [];
		expect([...container.querySelectorAll("[id]")].map((el) => el.id).sort()).toEqual(
			[...ids].sort(),
		);
	});

	it("renders the warning when there is no error", () => {
		const { container } = render(<FieldMessages id="f" warning="Taken." />);
		expect(container.querySelector("#f-warn")?.textContent).toBe("Taken.");
	});
});
