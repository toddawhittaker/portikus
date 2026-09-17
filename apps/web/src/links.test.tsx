import { expect, test } from "vitest";
import { canOpenInNewTab, fileRouteFor, previewRouteFor } from "./links";
import { decodeTerminalFrame } from "./terminalFrames";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

test("a localhost URL with a port becomes the preview route", () => {
	expect(previewRouteFor("http://localhost:3000", WORKSPACE, PROJECT)).toEqual({
		kind: "preview",
		to: "/workspaces/$id/projects/$projectId/preview/$port",
		params: { id: WORKSPACE, projectId: PROJECT, port: "3000" },
	});
});

test("a 127.0.0.1 URL with a port becomes the preview route", () => {
	expect(previewRouteFor("http://127.0.0.1:8000/todos", WORKSPACE, PROJECT)).toEqual({
		kind: "preview",
		to: "/workspaces/$id/projects/$projectId/preview/$port",
		params: { id: WORKSPACE, projectId: PROJECT, port: "8000" },
	});
});

test.each([
	["http with no port means 80", "http://localhost/", "80"],
	["https with no port means 443", "https://127.0.0.1/app", "443"],
])("%s", (_name, url, port) => {
	expect(previewRouteFor(url, WORKSPACE, PROJECT)).toEqual({
		kind: "preview",
		to: "/workspaces/$id/projects/$projectId/preview/$port",
		params: { id: WORKSPACE, projectId: PROJECT, port },
	});
});

test.each([
	["a non-local host", "https://example.invalid:3000"],
	["a non-http scheme", "file:///etc/passwd"],
	["text that is not a URL", "not a url"],
])("%s is not a preview route", (_name, url) => {
	expect(previewRouteFor(url, WORKSPACE, PROJECT)).toBeNull();
});

test("an ordinary remote URL may open in a new tab", () => {
	expect(canOpenInNewTab("https://example.invalid/docs")).toBe(true);
	expect(canOpenInNewTab("http://docs.example.invalid:8080/x")).toBe(true);
});

test.each([
	["localhost", "http://localhost/"],
	["localhost with a port", "http://localhost:3000/"],
	["127.0.0.1", "http://127.0.0.1:9000/"],
	["IPv6 loopback", "http://[::1]:9000/"],
	["the unspecified address", "http://0.0.0.0:9000/"],
	["a .localhost subdomain", "http://app.localhost/"],
	["an uppercase local host", "http://LOCALHOST/"],
	["a file URL", "file:///etc/passwd"],
	["a javascript URL", "javascript:alert(1)"],
	["text that is not a URL", "not a url"],
])("%s never opens in a new tab", (_name, url) => {
	expect(canOpenInNewTab(url)).toBe(false);
});

test("a relative path and line becomes the file route", () => {
	expect(fileRouteFor("src/auth.ts:73", WORKSPACE, PROJECT)).toEqual({
		kind: "file",
		to: "/workspaces/$id/projects/$projectId/files",
		params: { id: WORKSPACE, projectId: PROJECT },
		search: { path: "src/auth.ts", line: 73 },
	});
});

test.each([
	["a path that climbs out of the workspace", "../etc/passwd:1"],
	["an absolute path", "/etc/passwd:1"],
	["text with no line number", "src/auth.ts"],
])("%s is not a file route", (_name, match) => {
	expect(fileRouteFor(match, WORKSPACE, PROJECT)).toBeNull();
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
