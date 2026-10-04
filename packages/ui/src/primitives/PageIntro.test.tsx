import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageIntro } from "./PageIntro.js";

function renderIntro(helpHref?: string) {
	return render(
		<PageIntro id="admin-users" summary="About Users" helpHref={helpHref}>
			Everyone who has signed in, with their workspace.
		</PageIntro>,
	);
}

function toggle(details: HTMLDetailsElement, open: boolean) {
	details.open = open;
	fireEvent(details, new Event("toggle"));
}

afterEach(() => {
	window.localStorage.clear();
	vi.restoreAllMocks();
});

describe("PageIntro", () => {
	it("starts open with its summary and text", () => {
		renderIntro();
		const details = screen.getByTestId("intro-admin-users") as HTMLDetailsElement;
		expect(details.tagName).toBe("DETAILS");
		expect(details.open).toBe(true);
		expect(details.querySelector("summary")?.textContent).toBe("About Users");
		expect(details.textContent).toContain("Everyone who has signed in");
		expect(screen.queryByRole("link", { hidden: true })).toBeNull();
	});

	it("links to Help in a new tab and says so", () => {
		renderIntro("/admin/help#admin-users");
		// jsdom styles every details body as hidden, open or not.
		const link = screen.getByRole("link", {
			name: /More in Help ?\(opens in a new tab\)/,
			hidden: true,
		});
		expect(link.getAttribute("href")).toBe("/admin/help#admin-users");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noopener");
	});

	it("remembers being closed, and opened again", () => {
		const first = renderIntro();
		toggle(screen.getByTestId("intro-admin-users") as HTMLDetailsElement, false);
		expect(window.localStorage.getItem("pk-intro:admin-users")).toBe("closed");
		first.unmount();

		renderIntro();
		const details = screen.getByTestId("intro-admin-users") as HTMLDetailsElement;
		expect(details.open).toBe(false);
		toggle(details, true);
		expect(window.localStorage.getItem("pk-intro:admin-users")).toBe("open");
	});

	it("still works when storage throws", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		renderIntro();
		const details = screen.getByTestId("intro-admin-users") as HTMLDetailsElement;
		expect(details.open).toBe(true);
		expect(() => toggle(details, false)).not.toThrow();
		expect(details.open).toBe(false);
	});
});
