import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_CHAT_IMAGE_BYTES } from "@portikus/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { splitAttachmentLines, userContent } from "./attachments.js";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg==",
	"base64",
);

let home: string;
let project: string;

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "portikus-chat-attach-"));
	project = join(home, "projects", "demo");
	await mkdir(join(project, ".portikus", "pastes", "1"), { recursive: true });
	await writeFile(join(project, ".portikus", "pastes", "1", "red.png"), PNG);
	await writeFile(join(project, "notes.txt"), "hi");
	await writeFile(join(project, "logo.svg"), "<svg/>");
	await writeFile(join(project, "fake.png"), "not a png");
	await writeFile(
		join(project, "huge.png"),
		Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(MAX_CHAT_IMAGE_BYTES)]),
	);
	await writeFile(join(home, "secret.png"), PNG);
	await writeFile(join(project, "a.jpg"), Buffer.from("ffd8ffe000104a464946", "hex"));
	await writeFile(join(project, "a.gif"), "GIF89a....");
	await writeFile(join(project, "a.webp"), "RIFF\0\0\0\0WEBPVP8 ");
	await symlink(join(home, "secret.png"), join(project, "escape.png"));
});

afterAll(async () => {
	await rm(home, { recursive: true, force: true });
});

describe("send attachments", () => {
	test("an image becomes an image block and another file a line naming it", async () => {
		const content = await userContent(home, project, "look", [
			{ path: ".portikus/pastes/1/red.png" },
			{ path: "notes.txt" },
		]);
		expect(content).toEqual([
			{
				type: "text",
				text: "look\n\nAttached file: .portikus/pastes/1/red.png\n\nAttached file: notes.txt",
			},
			{
				type: "image",
				source: {
					type: "base64",
					media_type: "image/png",
					data: PNG.toString("base64"),
				},
			},
		]);
	});

	test("a symlink out of the project is refused", async () => {
		await expect(
			userContent(home, project, "", [{ path: "escape.png" }]),
		).rejects.toThrow(/leaves the project/);
	});

	test("SVG is refused", async () => {
		await expect(
			userContent(home, project, "", [{ path: "logo.svg" }]),
		).rejects.toThrow(/SVG/);
	});

	test("an image over the cap is refused", async () => {
		await expect(
			userContent(home, project, "", [{ path: "huge.png" }]),
		).rejects.toThrow(/too large/);
	});

	test("a file named like an image that is not one is refused", async () => {
		await expect(
			userContent(home, project, "", [{ path: "fake.png" }]),
		).rejects.toThrow(/not the image/);
	});

	test("a chat outside a project takes no attachments", async () => {
		await expect(
			userContent(home, home, "", [{ path: "secret.png" }]),
		).rejects.toThrow();
	});

	test("jpeg, gif and webp are recognised by their first bytes", async () => {
		const content = await userContent(home, project, "", [
			{ path: "a.jpg" },
			{ path: "a.gif" },
			{ path: "a.webp" },
		]);
		expect(
			content.map((block) =>
				block.type === "image" ? block.source.media_type : block.type,
			),
		).toEqual(["text", "image/jpeg", "image/gif", "image/webp"]);
	});
});

describe("attachment lines on replay", () => {
	test("the lines a send wrote split back into the typed text and the paths", async () => {
		const [block] = await userContent(home, project, "look\n\nhere", [
			{ path: ".portikus/pastes/1/red.png" },
			{ path: "notes.txt" },
		]);
		expect(splitAttachmentLines((block as { text: string }).text)).toEqual({
			text: "look\n\nhere",
			attachments: [{ path: ".portikus/pastes/1/red.png" }, { path: "notes.txt" }],
		});
	});

	test("files with no text leave the text empty", () => {
		expect(splitAttachmentLines("Attached file: a.png")).toEqual({
			text: "",
			attachments: [{ path: "a.png" }],
		});
	});

	test("text without attachment lines is unchanged", () => {
		expect(splitAttachmentLines("plain")).toEqual({ text: "plain", attachments: [] });
	});
});
