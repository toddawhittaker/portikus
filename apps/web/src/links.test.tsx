import { expect, test } from "vitest";
import { fileRouteFor, previewRouteFor } from "./links";
import { decodeTerminalFrame } from "./terminalFrames";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";

test("a localhost URL with a port becomes the preview route", () => {
	expect(previewRouteFor("http://localhost:3000", WORKSPACE)).toEqual({
		kind: "preview",
		to: "/workspaces/$id/preview/$port",
		params: { id: WORKSPACE, port: "3000" },
	});
});

test("a 127.0.0.1 URL with a port becomes the preview route", () => {
	expect(previewRouteFor("http://127.0.0.1:8000/todos", WORKSPACE)).toEqual({
		kind: "preview",
		to: "/workspaces/$id/preview/$port",
		params: { id: WORKSPACE, port: "8000" },
	});
});

test.each([
	["a non-local host", "https://example.invalid:3000"],
	["localhost without a port", "http://localhost/"],
	["a non-http scheme", "file:///etc/passwd"],
	["text that is not a URL", "not a url"],
])("%s is not a preview route", (_name, url) => {
	expect(previewRouteFor(url, WORKSPACE)).toBeNull();
});

test("a relative path and line becomes the file route", () => {
	expect(fileRouteFor("src/auth.ts:73", WORKSPACE)).toEqual({
		kind: "file",
		to: "/workspaces/$id/files",
		params: { id: WORKSPACE },
		search: { path: "src/auth.ts", line: 73 },
	});
});

test.each([
	["a path that climbs out of the workspace", "../etc/passwd:1"],
	["an absolute path", "/etc/passwd:1"],
	["text with no line number", "src/auth.ts"],
])("%s is not a file route", (_name, match) => {
	expect(fileRouteFor(match, WORKSPACE)).toBeNull();
});

test("terminal frames decode by kind", () => {
	const bytes = new Uint8Array([104, 105]);
	expect(decodeTerminalFrame(bytes.buffer)).toEqual({ kind: "output", bytes });
	expect(decodeTerminalFrame('{"type":"exit"}')).toEqual({ kind: "exit" });
	expect(decodeTerminalFrame('{"type":"error","code":"agent_unavailable"}')).toEqual({
		kind: "error",
		code: "agent_unavailable",
	});
	expect(decodeTerminalFrame("not json")).toEqual({ kind: "ignored" });
});
