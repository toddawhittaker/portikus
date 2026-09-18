import { expect, test } from "vitest";
import {
	canOpenInNewTab,
	fileRouteFor,
	previewRouteFor,
	wrappedUrlsOnRow,
} from "./links";
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

/**
 * A fake terminal buffer: rows of exactly `cols` cells, with trailing blanks
 * removed the way xterm.js removes them.
 */
function paneOf(text: string, cols: number): (y: number) => string | null {
	const rows: string[] = [];
	for (let at = 0; at < text.length; at += cols) {
		rows.push(text.slice(at, at + cols).replace(/ +$/, ""));
	}
	return (y) => rows[y - 1] ?? null;
}

const LONG_URL = `https://accounts.example.com/oauth/authorize?client_id=${"a".repeat(80)}&state=${"b".repeat(60)}&redirect_uri=http%3A%2F%2Flocalhost%3A1455`;

test("a URL wrapped over four rows is one link on each of its rows", () => {
	expect(LONG_URL.length).toBeGreaterThan(200);
	const rows = Math.ceil(LONG_URL.length / 80);
	const row = paneOf(LONG_URL, 80);
	const first = wrappedUrlsOnRow(1, row, 80);
	expect(first).toHaveLength(1);
	expect(first[0]?.text).toBe(LONG_URL);
	expect(first[0]?.range.start).toEqual({ x: 1, y: 1 });
	expect(first[0]?.range.end).toEqual({
		x: LONG_URL.length - (rows - 1) * 80,
		y: rows,
	});
	// Hovering any other row of the URL finds the same whole link.
	for (let y = 2; y <= rows; y += 1) {
		expect(wrappedUrlsOnRow(y, row, 80)).toEqual(first);
	}
});

test("a URL that starts part way along a wrapped line keeps its start cell", () => {
	const row = paneOf(`Open this: ${LONG_URL}`, 80);
	const link = wrappedUrlsOnRow(2, row, 80)[0];
	expect(link?.text).toBe(LONG_URL);
	expect(link?.range.start).toEqual({ x: 12, y: 1 });
});

test("a URL that fits on one row is left to the web-links addon", () => {
	const row = paneOf("visit http://localhost:3000 now", 80);
	expect(wrappedUrlsOnRow(1, row, 80)).toEqual([]);
});

test("a full-width row that is not followed by more text yields nothing", () => {
	const row = paneOf("x".repeat(80), 80);
	expect(wrappedUrlsOnRow(1, row, 80)).toEqual([]);
});

test("a full stop after a wrapped URL is not part of it", () => {
	const row = paneOf(`${LONG_URL}.`, 80);
	expect(wrappedUrlsOnRow(1, row, 80)[0]?.text).toBe(LONG_URL);
});
