import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileInput } from "./FileInput.js";

describe("FileInput", () => {
	it("is a native file input named by its label", () => {
		render(<FileInput id="cert" label="Certificate" accept=".pem" />);
		const input = screen.getByLabelText("Certificate") as HTMLInputElement;
		expect(input.type).toBe("file");
		expect(input.accept).toBe(".pem");
	});

	it("links its hint as the description (SPEC.md section 25.8)", () => {
		render(<FileInput id="key" label="Private key" hint="Not set." />);
		const input = screen.getByLabelText("Private key");
		expect(input.getAttribute("aria-describedby")).toBe("key-hint");
		expect(document.getElementById("key-hint")?.textContent).toBe("Not set.");
		expect(input.hasAttribute("aria-invalid")).toBe(false);
	});

	it("has no description without a hint or an error", () => {
		render(<FileInput id="bare" label="Bare" />);
		expect(screen.getByLabelText("Bare").hasAttribute("aria-describedby")).toBe(false);
	});

	it("links its error before the hint and marks the input invalid", () => {
		render(
			<FileInput
				id="chain"
				label="Chain"
				hint="Optional."
				error="Not in PEM format."
			/>,
		);
		const input = screen.getByLabelText("Chain");
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(input.getAttribute("aria-describedby")).toBe("chain-err chain-hint");
		expect(document.getElementById("chain-err")?.textContent).toBe(
			"Not in PEM format.",
		);
	});

	it("passes the chosen file to onChange", () => {
		const onChange = vi.fn();
		render(<FileInput id="f" label="File" onChange={onChange} />);
		const file = new File(["text"], "site.pem");
		fireEvent.change(screen.getByLabelText("File"), { target: { files: [file] } });
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange.mock.calls[0]?.[0].target.files[0]).toBe(file);
	});
});
