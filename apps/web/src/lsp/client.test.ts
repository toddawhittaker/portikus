/**
 * The language-server client against a scripted socket: what it asks the
 * server for, what it syncs, and what each close code makes it do
 * (SPEC.md §13.6).
 */
import { CloseCode, LANGUAGE_SERVER_MAX_DOCUMENT_BYTES } from "@portikus/contracts";
import type * as Monaco from "monaco-editor";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	answerServerRequest,
	fitsDocumentLimit,
	initializeParams,
	LanguageClient,
	statusAfterClose,
} from "./client.js";
import { closeAction, MAX_RETRY_MS, nextBackoff } from "./connection.js";
import { useCodeHelpStore } from "./store.js";

interface Sent {
	id?: number;
	method?: string;
	// biome-ignore lint/suspicious/noExplicitAny: the tests read whatever shape each method sends
	params?: any;
	result?: unknown;
	error?: unknown;
}

class FakeWebSocket {
	static OPEN = 1;
	static all: FakeWebSocket[] = [];
	readyState = 0;
	sent: Sent[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(readonly url: string) {
		FakeWebSocket.all.push(this);
	}
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		this.readyState = 3;
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
	receive(message: object) {
		this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", ...message }) });
	}
	serverClose(code: number, reason = "") {
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}
	methods() {
		return this.sent.map((message) => message.method);
	}
	/** Open and answer `initialize` with these capabilities. */
	async ready(capabilities: object = {}) {
		this.open();
		const init = this.sent.find((message) => message.method === "initialize");
		this.receive({ id: init?.id, result: { capabilities } });
		await Promise.resolve();
		await Promise.resolve();
	}
}

const latest = () => FakeWebSocket.all[FakeWebSocket.all.length - 1] as FakeWebSocket;

function fakeModel(text: string, language = "python") {
	let version = 1;
	let disposed = false;
	return {
		uri: { toString: () => "pk:/p1/main.py" },
		getValue: () => text,
		getValueLength: () => text.length,
		getVersionId: () => version,
		getLanguageId: () => language,
		isDisposed: () => disposed,
		edit(next: string) {
			text = next;
			version += 1;
		},
		dispose() {
			disposed = true;
		},
	};
}
type FakeModel = ReturnType<typeof fakeModel>;
const asModel = (model: FakeModel) => model as unknown as Monaco.editor.ITextModel;

const setModelMarkers = vi.fn();
const monaco = {
	editor: { setModelMarkers },
	MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
} as unknown as typeof Monaco;

function makeClient(onDisabled = vi.fn()) {
	return new LanguageClient({
		monaco,
		url: "ws://test/workspaces/w1/projects/p1/language-servers/python",
		projectId: "p1",
		root: "/home/student/projects/demo",
		projectName: "demo",
		server: "python",
		onDisabled,
	});
}

const status = () => useCodeHelpStore.getState().status.p1?.python;

beforeEach(() => {
	FakeWebSocket.all = [];
	setModelMarkers.mockClear();
	useCodeHelpStore.getState().clearProject("p1");
	vi.stubGlobal("WebSocket", FakeWebSocket);
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test("initialize asks for no snippets and no file operations", () => {
	const params = initializeParams("/home/student/projects/demo", "demo");
	const caps = params.capabilities;
	expect(caps.textDocument?.completion?.completionItem?.snippetSupport).toBe(false);
	expect(caps.workspace?.workspaceEdit?.resourceOperations).toEqual([]);
	expect(caps.workspace?.applyEdit).toBe(false);
	expect(params.rootUri).toBe("file:///home/student/projects/demo");
});

test("server requests are answered: registration succeeds, settings are empty", () => {
	const folder = { uri: "file:///r", name: "r" };
	expect(answerServerRequest("client/registerCapability", {}, folder)).toBeNull();
	expect(
		answerServerRequest(
			"workspace/configuration",
			{ items: [{}, { section: "x" }] },
			folder,
		),
	).toEqual([{}, {}]);
	expect(answerServerRequest("workspace/workspaceFolders", null, folder)).toEqual([
		folder,
	]);
});

test("a server may not edit files, open windows or run commands", () => {
	const folder = { uri: "file:///r", name: "r" };
	expect(answerServerRequest("workspace/applyEdit", {}, folder)).toMatchObject({
		applied: false,
	});
	expect(answerServerRequest("window/showDocument", {}, folder)).toEqual({
		success: false,
	});
	expect(() => answerServerRequest("workspace/executeCommand", {}, folder)).toThrow();
});

test("the document limit is 512 KiB of UTF-8, not of characters", () => {
	expect(LANGUAGE_SERVER_MAX_DOCUMENT_BYTES).toBe(512 * 1024);
	expect(fitsDocumentLimit("a".repeat(512 * 1024))).toBe(true);
	expect(fitsDocumentLimit("a".repeat(512 * 1024 + 1))).toBe(false);
	// Three bytes each in UTF-8.
	expect(fitsDocumentLimit("€".repeat(200 * 1024))).toBe(false);
});

test("close codes map to what the client does next", () => {
	expect(closeAction(CloseCode.LANGUAGE_SERVER_REPLACED)).toBe("replaced");
	expect(closeAction(CloseCode.LANGUAGE_SERVER_IDLE)).toBe("idle");
	expect(closeAction(CloseCode.LANGUAGE_SERVER_CRASHED)).toBe("crashed");
	expect(closeAction(CloseCode.LANGUAGE_SERVER_UNAVAILABLE)).toBe("unavailable");
	expect(closeAction(CloseCode.LANGUAGE_SERVER_DISABLED)).toBe("disabled");
	expect(closeAction(CloseCode.SESSION_ENDED)).toBe("refused");
	expect(closeAction(1006)).toBe("retry");
	expect(
		statusAfterClose("crashed", "crashed: may have run out of memory").detail,
	).toMatch(/memory/);
	expect(statusAfterClose("crashed", "crashed")).toEqual({ state: "crashed" });
	expect(statusAfterClose("crashed", "out of memory, see /etc/x")).toEqual({
		state: "crashed",
	});
	expect(statusAfterClose("idle", "")).toEqual({ state: "quiet" });
	expect(statusAfterClose("disabled", "")).toEqual({ state: "quiet" });
});

test("backoff doubles for young sockets up to 15 seconds and resets after a healthy one", () => {
	expect(nextBackoff(1000, 100)).toBe(2000);
	expect(nextBackoff(MAX_RETRY_MS, 100)).toBe(MAX_RETRY_MS);
	expect(nextBackoff(8000, 60_000)).toBe(1000);
});

test("a tracked model opens the socket, initializes, then is opened on the server", async () => {
	const client = makeClient();
	const model = fakeModel("x = 1\n");
	client.track(asModel(model), "src/main.py");
	expect(FakeWebSocket.all).toHaveLength(1);
	expect(status()?.state).toBe("starting");
	await latest().ready();
	expect(status()?.state).toBe("ready");
	expect(latest().methods()).toEqual([
		"initialize",
		"initialized",
		"textDocument/didOpen",
	]);
	const open = latest().sent[2]?.params;
	expect(open.textDocument).toMatchObject({
		uri: "file:///home/student/projects/demo/src/main.py",
		languageId: "python",
		version: 1,
		text: "x = 1\n",
	});
	client.dispose();
});

test("an edit is sent as an incremental change with 0-based positions", async () => {
	const client = makeClient();
	const model = fakeModel("x = 1\n");
	client.track(asModel(model), "main.py");
	await latest().ready();
	model.edit("x = 12\n");
	client.change(asModel(model), {
		changes: [
			{
				range: { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 6 },
				rangeLength: 0,
				rangeOffset: 5,
				text: "2",
			},
		],
	} as unknown as Monaco.editor.IModelContentChangedEvent);
	const change = latest().sent.find((m) => m.method === "textDocument/didChange");
	expect(change?.params).toEqual({
		textDocument: { uri: "file:///home/student/projects/demo/main.py", version: 2 },
		contentChanges: [
			{
				range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } },
				rangeLength: 0,
				text: "2",
			},
		],
	});
	client.dispose();
});

test("a file over the limit is never sent", async () => {
	const client = makeClient();
	client.track(asModel(fakeModel("a".repeat(600 * 1024))), "big.py");
	await latest().ready();
	expect(latest().methods()).not.toContain("textDocument/didOpen");
	client.dispose();
});

test("pushed diagnostics become markers and problems", async () => {
	const client = makeClient();
	const model = fakeModel("x\n");
	client.track(asModel(model), "main.py");
	await latest().ready();
	latest().receive({
		method: "textDocument/publishDiagnostics",
		params: {
			uri: "file:///home/student/projects/demo/main.py",
			diagnostics: [
				{
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
					severity: 1,
					message: "x is not defined",
					source: "Pyright",
				},
			],
		},
	});
	expect(setModelMarkers).toHaveBeenLastCalledWith(model, "lsp-python", [
		expect.objectContaining({ startLineNumber: 1, startColumn: 1, severity: 8 }),
	]);
	const problems = useCodeHelpStore.getState().problems.p1?.["main.py"]?.python;
	expect(problems).toEqual([
		{
			path: "main.py",
			line: 1,
			column: 1,
			severity: "error",
			message: "x is not defined",
			source: "Pyright",
		},
	]);
	client.dispose();
});

test("a pull-diagnostics server is asked after open", async () => {
	const client = makeClient();
	client.track(asModel(fakeModel("let x\n", "typescript")), "a.ts");
	await latest().ready({ diagnosticProvider: { interFileDependencies: true } });
	vi.advanceTimersByTime(400);
	const pull = latest().sent.find((m) => m.method === "textDocument/diagnostic");
	expect(pull?.params).toEqual({
		textDocument: { uri: "file:///home/student/projects/demo/a.ts" },
	});
	client.dispose();
});

test("the server's own requests are answered on the socket", async () => {
	const client = makeClient();
	client.track(asModel(fakeModel("x\n")), "main.py");
	await latest().ready();
	latest().receive({
		id: 7,
		method: "client/registerCapability",
		params: { registrations: [] },
	});
	latest().receive({
		id: 8,
		method: "workspace/configuration",
		params: { items: [{}] },
	});
	latest().receive({ id: 9, method: "workspace/executeCommand", params: {} });
	expect(latest().sent.find((m) => m.id === 7)).toMatchObject({ result: null });
	expect(latest().sent.find((m) => m.id === 8)).toMatchObject({ result: [{}] });
	expect(latest().sent.find((m) => m.id === 9)?.error).toBeDefined();
	client.dispose();
});

test("files changed on disk are sent as watched-file changes", async () => {
	const client = makeClient();
	client.track(asModel(fakeModel("x\n")), "main.py");
	await latest().ready();
	client.filesChanged(["lib/util.py"]);
	const sent = latest().sent.find(
		(m) => m.method === "workspace/didChangeWatchedFiles",
	);
	expect(sent?.params).toEqual({
		changes: [{ uri: "file:///home/student/projects/demo/lib/util.py", type: 2 }],
	});
	client.dispose();
});

test("REPLACED stops and waits for Use here", async () => {
	const client = makeClient();
	client.track(asModel(fakeModel("x\n")), "main.py");
	await latest().ready();
	latest().serverClose(CloseCode.LANGUAGE_SERVER_REPLACED);
	expect(status()?.state).toBe("replaced");
	vi.advanceTimersByTime(60_000);
	client.wake();
	client.track(asModel(fakeModel("y\n")), "other.py");
	expect(FakeWebSocket.all).toHaveLength(1);
	client.restart();
	expect(FakeWebSocket.all).toHaveLength(2);
	client.dispose();
});

test("IDLE shows nothing and reconnects at the next edit or focus", async () => {
	const client = makeClient();
	const model = fakeModel("x\n");
	client.track(asModel(model), "main.py");
	await latest().ready();
	latest().serverClose(CloseCode.LANGUAGE_SERVER_IDLE);
	expect(status()?.state).toBe("quiet");
	vi.advanceTimersByTime(60_000);
	expect(FakeWebSocket.all).toHaveLength(1);
	client.change(asModel(model), {
		changes: [],
	} as unknown as Monaco.editor.IModelContentChangedEvent);
	expect(FakeWebSocket.all).toHaveLength(2);
	await latest().ready();
	expect(latest().methods()).toContain("textDocument/didOpen");
	client.dispose();
});

test("CRASHED and UNAVAILABLE show their state and wait for Restart", async () => {
	for (const [code, state] of [
		[CloseCode.LANGUAGE_SERVER_CRASHED, "crashed"],
		[CloseCode.LANGUAGE_SERVER_UNAVAILABLE, "unavailable"],
	] as const) {
		FakeWebSocket.all = [];
		const client = makeClient();
		client.track(asModel(fakeModel("x\n")), "main.py");
		latest().serverClose(code);
		expect(status()?.state).toBe(state);
		vi.advanceTimersByTime(60_000);
		expect(FakeWebSocket.all).toHaveLength(1);
		client.dispose();
	}
});

test("DISABLED tells the manager and is never retried", async () => {
	const onDisabled = vi.fn();
	const client = makeClient(onDisabled);
	client.track(asModel(fakeModel("x\n")), "main.py");
	latest().serverClose(CloseCode.LANGUAGE_SERVER_DISABLED);
	expect(onDisabled).toHaveBeenCalledTimes(1);
	vi.advanceTimersByTime(60_000);
	expect(FakeWebSocket.all).toHaveLength(1);
	client.dispose();
});

test("a dropped socket is retried with backoff and shows starting", async () => {
	const client = makeClient();
	client.track(asModel(fakeModel("x\n")), "main.py");
	latest().serverClose(1006);
	expect(status()?.state).toBe("starting");
	vi.advanceTimersByTime(999);
	expect(FakeWebSocket.all).toHaveLength(1);
	vi.advanceTimersByTime(1);
	expect(FakeWebSocket.all).toHaveLength(2);
	client.dispose();
});
