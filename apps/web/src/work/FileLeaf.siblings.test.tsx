/**
 * A viewed file too large to carry an etag takes its address version from
 * its folder listing; the listing pages at 2,000 entries, so the lookup
 * follows the pages until the file turns up (SPEC.md §11.2, §13.2).
 */
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../test-utils.js";
import { FileLeaf } from "./FileLeaf.js";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const PATH = "pics/z.png";

function entry(name: string, size = 1, mtimeMs = 1) {
	return { name, type: "file" as const, size, mtimeMs };
}

/** A read past the editor limit: 413, so there is no etag. */
function tooLarge() {
	return new Response(
		JSON.stringify({ error: { code: "FILE_TOO_LARGE", message: "" } }),
		{
			status: 413,
			headers: { "content-type": "application/json" },
		},
	);
}

function renderLeaf() {
	return renderWithQuery(
		<FileLeaf path={PATH} workspaceId="ws-1" projectId="p-1" onClose={() => {}} />,
	);
}

const settings = (url: string) =>
	url === "/me/settings" ? json(200, { timezones: [] }) : null;

test("the sibling lookup follows pages until it finds the file", async () => {
	const trees: string[] = [];
	stubFetch((url) => {
		if (url.includes("/tree?")) {
			trees.push(url);
			if (url.includes("after=")) {
				return json(200, { entries: [entry("z.png", 7, 9)], truncated: false });
			}
			return json(200, {
				entries: [entry("a.png")],
				truncated: true,
				next: "f/a.png",
			});
		}
		return settings(url) ?? tooLarge();
	});
	renderLeaf();
	const image = (await screen.findByRole("img", { name: "z.png" })) as HTMLImageElement;
	expect(image.getAttribute("src")).toContain("&v=7-9");
	expect(trees).toHaveLength(2);
});

test("the lookup stops when the last page does not hold the file", async () => {
	const trees: string[] = [];
	stubFetch((url) => {
		if (url.includes("/tree?")) {
			trees.push(url);
			if (url.includes("after=f%2Fb.png")) {
				return json(200, { entries: [entry("c.png")], truncated: false });
			}
			if (url.includes("after=")) {
				return json(200, {
					entries: [entry("b.png")],
					truncated: true,
					next: "f/b.png",
				});
			}
			return json(200, { entries: [entry("a.png")], truncated: true, next: "f/a.png" });
		}
		return settings(url) ?? tooLarge();
	});
	renderLeaf();
	const image = (await screen.findByRole("img", { name: "z.png" })) as HTMLImageElement;
	await waitFor(() => expect(trees).toHaveLength(3));
	// Listed nowhere: the address carries no version, and the lookup is over.
	expect(image.getAttribute("src")).not.toContain("&v=");
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(trees).toHaveLength(3);
});

test("a next page that fails ends the lookup instead of asking again", async () => {
	const trees: string[] = [];
	stubFetch((url) => {
		if (url.includes("/tree?")) {
			trees.push(url);
			if (url.includes("after=")) {
				return json(500, { error: { code: "INTERNAL", message: "boom" } });
			}
			return json(200, { entries: [entry("a.png")], truncated: true, next: "f/a.png" });
		}
		return settings(url) ?? tooLarge();
	});
	renderLeaf();
	// The viewer shows without a version rather than staying on "Loading…".
	await screen.findByRole("img", { name: "z.png" });
	expect(screen.queryByText("Loading…")).toBeNull();
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(trees).toHaveLength(2);
});
