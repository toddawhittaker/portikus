import { describe, expect, test } from "vitest";
import { ChatTitle } from "./titles.js";

const ID = "5d0f4a7e-0a51-4b8e-9d0e-6c3f1b2a9e10";

function setup(read: () => Promise<string | null>) {
	const posted: (string | null)[] = [];
	const renamed: string[] = [];
	let failPost = false;
	let failRename = false;
	const title = new ChatTitle(
		{
			sessionTitle: read,
			renameSession: async (_id, text) => {
				if (failRename) throw new Error("disk full");
				renamed.push(text);
			},
		},
		"/project",
		async (text) => {
			if (failPost) throw new Error("receiver down");
			posted.push(text);
		},
	);
	return {
		title,
		posted,
		renamed,
		failPost: (fail: boolean) => {
			failPost = fail;
		},
		failRename: (fail: boolean) => {
			failRename = fail;
		},
	};
}

describe("ChatTitle", () => {
	test("a long first prompt is published as one line of at most 80 characters", async () => {
		const { title, posted } = setup(
			async () => `Line one\nline two ${"x".repeat(200)}`,
		);
		await title.refresh(ID);
		expect(posted).toHaveLength(1);
		expect(posted[0]?.startsWith("Line one line two x")).toBe(true);
		expect(posted[0]?.length).toBe(80);
	});

	test("a failed post is tried again on the next refresh", async () => {
		const { title, posted, failPost } = setup(async () => "Fix the build");
		failPost(true);
		await title.refresh(ID);
		failPost(false);
		await title.refresh(ID);
		expect(posted).toEqual(["Fix the build"]);
	});

	test("a failed read keeps the last title", async () => {
		let fail = false;
		const { title, posted } = setup(async () => {
			if (fail) throw new Error("no file");
			return "Kept";
		});
		await title.refresh(ID);
		fail = true;
		await title.refresh(ID);
		expect(posted).toEqual(["Kept"]);
	});

	test("reset publishes the same title again", async () => {
		const { title, posted } = setup(async () => null);
		await title.refresh(ID);
		title.reset();
		await title.refresh(ID);
		expect(posted).toEqual([null, null]);
	});

	test("a rename the SDK cannot save says so and publishes nothing", async () => {
		const { title, posted, failRename } = setup(async () => null);
		failRename(true);
		await expect(title.rename(ID, "New name")).rejects.toThrow(/could not be renamed/);
		expect(posted).toEqual([]);
	});

	test("a rename to nothing but blanks is refused before the SDK is called", async () => {
		const { title, renamed } = setup(async () => null);
		await expect(title.rename(ID, "\u0000\t ")).rejects.toThrow(/at least one/);
		expect(renamed).toEqual([]);
	});
});
