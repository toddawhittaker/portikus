import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_CHAT_IMAGE_BYTES } from "@portikus/contracts";
import Fastify from "fastify";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readChatImage, sniffImageType } from "./chat-image.js";
import { filesRoutes } from "./files-route.js";

/**
 * SPEC.md §24.1: an assistant reply may show png, jpeg, gif or webp files
 * from the project or the student's home folder, and nothing else.
 */

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

let root: string;
let home: string;
let project: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "portikus-chat-image-"));
	home = join(root, "home");
	project = join(home, "projects", "demo");
	await mkdir(join(project, ".portikus"), { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function code(path: string): Promise<string> {
	try {
		await readChatImage(home, "demo", path);
		return "served";
	} catch (error) {
		return (error as { code: string }).code;
	}
}

test("a project-relative image is served with its type", async () => {
	await writeFile(join(project, ".portikus", "shot.png"), PNG);
	const image = await readChatImage(home, "demo", ".portikus/shot.png");
	expect(image.contentType).toBe("image/png");
	expect(image.body.equals(PNG)).toBe(true);
});

test("an absolute path anywhere under the home folder is served", async () => {
	await writeFile(join(home, "portfolio-screenshot.png"), PNG);
	expect(await code(join(home, "portfolio-screenshot.png"))).toBe("served");
});

test("a path outside the home folder is refused", async () => {
	await writeFile(join(root, "outside.png"), PNG);
	expect(await code(join(root, "outside.png"))).toBe("PATH_INVALID");
	expect(await code("../../../outside.png")).toBe("PATH_INVALID");
});

test("a symlink that leaves the home folder is refused", async () => {
	await writeFile(join(root, "secret.png"), PNG);
	await symlink(join(root, "secret.png"), join(project, "link.png"));
	await symlink(root, join(home, "out"));
	expect(await code("link.png")).toBe("PATH_INVALID");
	expect(await code(join(home, "out", "secret.png"))).toBe("PATH_INVALID");
});

test("SVG is refused, even renamed to .png", async () => {
	const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>';
	await writeFile(join(project, "logo.svg"), svg);
	await writeFile(join(project, "logo.png"), svg);
	expect(await code("logo.svg")).toBe("BAD_REQUEST");
	expect(await code("logo.png")).toBe("BAD_REQUEST");
});

test("an image past the 5 MiB cap is refused, and one at the cap is served", async () => {
	const big = Buffer.alloc(MAX_CHAT_IMAGE_BYTES + 1);
	PNG.copy(big);
	await writeFile(join(project, "big.png"), big);
	await writeFile(join(project, "edge.png"), big.subarray(0, MAX_CHAT_IMAGE_BYTES));
	expect(await code("big.png")).toBe("FILE_TOO_LARGE");
	expect(await code("edge.png")).toBe("served");
});

test("a missing file and a directory are refused", async () => {
	await mkdir(join(project, "dir.png"));
	expect(await code("missing.png")).toBe("FILE_NOT_FOUND");
	expect(await code("dir.png")).toBe("BAD_REQUEST");
});

test("a named pipe is refused at once instead of waiting for a writer", async () => {
	execFileSync("mkfifo", [join(project, "pipe.png")]);
	expect(await code("pipe.png")).toBe("BAD_REQUEST");
}, 2000);

test("a small image is read whole", async () => {
	await writeFile(join(project, "small.png"), PNG);
	const image = await readChatImage(home, "demo", "small.png");
	expect(image.body.length).toBe(PNG.length);
});

test("the bytes are sniffed for each allowed type", () => {
	expect(sniffImageType(PNG)).toBe("image/png");
	expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
	expect(sniffImageType(Buffer.from("GIF89a"))).toBe("image/gif");
	expect(sniffImageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
	expect(sniffImageType(Buffer.from("<html>"))).toBeNull();
});

test("the route serves an image and maps a refusal to its status", async () => {
	await writeFile(join(project, "shot.png"), PNG);
	const app = Fastify();
	await app.register(filesRoutes, { homeDir: home });
	const ok = await app.inject({ url: "/projects/demo/image?path=shot.png" });
	expect(ok.statusCode).toBe(200);
	expect(ok.headers["content-type"]).toBe("image/png");
	expect(ok.rawPayload.equals(PNG)).toBe(true);
	const missing = await app.inject({ url: "/projects/demo/image?path=nope.png" });
	expect(missing.statusCode).toBe(404);
	await app.close();
});
