/**
 * The client for one project and one language server (SPEC.md §13.6): the
 * socket's lifecycle, `initialize`, the sync of the project's open models,
 * and diagnostics, both pushed and pulled. Editing never waits on it.
 */
import {
	LANGUAGE_SERVER_CLOSE_REASONS,
	LANGUAGE_SERVER_MAX_DOCUMENT_BYTES,
	type LanguageServerId,
} from "@portikus/contracts";
import type * as Monaco from "monaco-editor";
import type {
	ConfigurationParams,
	Diagnostic,
	DocumentDiagnosticReport,
	InitializeParams,
	InitializeResult,
	PublishDiagnosticsParams,
	ServerCapabilities,
} from "vscode-languageserver-protocol";
import {
	type CloseAction,
	closeAction,
	FIRST_RETRY_MS,
	nextBackoff,
	RpcConnection,
} from "./connection.js";
import {
	pathFromServerUri,
	serverUri,
	toContentChange,
	toMarker,
	toProblem,
} from "./protocol.js";
import { lspLanguageId } from "./servers.js";
import { type ServerStatus, useCodeHelpStore } from "./store.js";

const PULL_DEBOUNCE_MS = 300;

/**
 * The API's cap on one browser frame (SPEC.md §13.6: 1 MiB). A bigger one is
 * closed as too big, which the client would retry for ever.
 */
export const MAX_BROWSER_FRAME_BYTES = 1024 * 1024;
// Room in a didOpen frame for everything but the text, with a long path's URI.
const FRAME_ENVELOPE_BYTES = 16 * 1024;
// A UTF-16 unit is at most three UTF-8 bytes, and at most six once JSON escapes it.
const MAX_BYTES_PER_UNIT = 3;
const MAX_JSON_BYTES_PER_UNIT = 6;

/**
 * Whether a document is small enough to send: 512 KiB of text (SPEC.md
 * §13.6), and a didOpen frame within the browser frame cap once JSON escapes
 * its quotes, newlines and control characters.
 */
export function fitsDocumentLimit(text: string): boolean {
	if (fitsWithoutMeasuring(text.length)) return true;
	if (text.length > LANGUAGE_SERVER_MAX_DOCUMENT_BYTES) return false;
	const encoder = new TextEncoder();
	if (encoder.encode(text).length > LANGUAGE_SERVER_MAX_DOCUMENT_BYTES) return false;
	const frameText = encoder.encode(JSON.stringify(text)).length;
	return frameText + FRAME_ENVELOPE_BYTES <= MAX_BROWSER_FRAME_BYTES;
}

/** True when a text of this many UTF-16 units fits however it encodes. */
function fitsWithoutMeasuring(units: number): boolean {
	return (
		units * MAX_BYTES_PER_UNIT <= LANGUAGE_SERVER_MAX_DOCUMENT_BYTES &&
		units * MAX_JSON_BYTES_PER_UNIT + FRAME_ENVELOPE_BYTES <= MAX_BROWSER_FRAME_BYTES
	);
}

/** The same, without copying the text of an ordinary file on every keystroke. */
export function modelFitsLimit(model: Monaco.editor.ITextModel): boolean {
	if (fitsWithoutMeasuring(model.getValueLength())) return true;
	return fitsDocumentLimit(model.getValue());
}

/** The client capabilities: no snippets, no file operations (SPEC.md §13.6). */
export function initializeParams(root: string, name: string): InitializeParams {
	const rootUri = `file://${root.split("/").map(encodeURIComponent).join("/")}`;
	return {
		// The agent puts its own pid and the real project path here.
		processId: null,
		rootUri,
		workspaceFolders: [{ uri: rootUri, name }],
		clientInfo: { name: "Portikus" },
		capabilities: {
			general: { positionEncodings: ["utf-16"] },
			textDocument: {
				synchronization: { dynamicRegistration: false, didSave: false },
				completion: {
					completionItem: {
						snippetSupport: false,
						documentationFormat: ["markdown", "plaintext"],
					},
				},
				hover: { contentFormat: ["markdown", "plaintext"] },
				definition: { linkSupport: true },
				rename: { prepareSupport: false },
				formatting: {},
				publishDiagnostics: {},
				diagnostic: { dynamicRegistration: false },
			},
			workspace: {
				applyEdit: false,
				workspaceEdit: { documentChanges: true, resourceOperations: [] },
				configuration: true,
				workspaceFolders: true,
				// Without this the TypeScript server turns its own file watching off.
				didChangeWatchedFiles: { dynamicRegistration: true },
			},
		},
	};
}

/** What the client says to each request a server may send it. */
export function answerServerRequest(
	method: string,
	params: unknown,
	folder: { uri: string; name: string },
): unknown {
	switch (method) {
		case "client/registerCapability":
		case "client/unregisterCapability":
		case "window/workDoneProgress/create":
		case "window/showMessageRequest":
		case "workspace/diagnostic/refresh":
		case "workspace/semanticTokens/refresh":
		case "workspace/inlayHint/refresh":
		case "workspace/codeLens/refresh":
			return null;
		case "workspace/configuration":
			return (params as ConfigurationParams).items.map(() => ({}));
		case "workspace/workspaceFolders":
			return [folder];
		// A server may not change files or open windows on its own.
		case "workspace/applyEdit":
			return { applied: false, failureReason: "Not supported" };
		case "window/showDocument":
			return { success: false };
		default:
			// workspace/executeCommand and anything unknown is refused.
			throw new Error("Not supported");
	}
}

/** The status a close leaves behind; the raw reason is never shown. */
export function statusAfterClose(action: CloseAction, reason: string): ServerStatus {
	switch (action) {
		case "replaced":
			return { state: "replaced" };
		case "crashed":
			return reason === LANGUAGE_SERVER_CLOSE_REASONS.outOfMemory
				? { state: "crashed", detail: "It may have run out of memory." }
				: { state: "crashed" };
		case "unavailable":
			return { state: "unavailable" };
		case "retry":
			return { state: "starting" };
		default:
			return { state: "quiet" };
	}
}

interface TrackedDocument {
	model: Monaco.editor.ITextModel;
	path: string;
	uri: string;
	/** True when the server has it open. */
	open: boolean;
	pull?: ReturnType<typeof setTimeout>;
}

export interface ClientOptions {
	monaco: typeof Monaco;
	url: string;
	projectId: string;
	/** The project's real path in the workspace. */
	root: string;
	projectName: string;
	server: LanguageServerId;
	/** A DISABLED close: code help is off for this server's language. */
	onDisabled: () => void;
}

/** "new" until the first document; "stopped" waits for Restart or "Use here". */
type Mode = "new" | "running" | "idle" | "stopped";

export class LanguageClient {
	private connection: RpcConnection | null = null;
	private capabilities: ServerCapabilities | null = null;
	private docs = new Map<string, TrackedDocument>();
	private mode: Mode = "new";
	private backoffMs = FIRST_RETRY_MS;
	private retry?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private readonly owner: string;

	constructor(private readonly options: ClientOptions) {
		this.owner = `lsp-${options.server}`;
	}

	get server(): LanguageServerId {
		return this.options.server;
	}

	/** The server's capabilities once it is ready, else null. */
	get ready(): ServerCapabilities | null {
		return this.capabilities;
	}

	private setStatus(status: ServerStatus): void {
		useCodeHelpStore.getState().setStatus(this.options.projectId, this.server, status);
	}

	private run(): void {
		if (this.disposed) return;
		this.mode = "running";
		this.connect();
	}

	/** Restart, or "Use here": always opens a new socket. */
	restart(): void {
		this.backoffMs = FIRST_RETRY_MS;
		this.stopSocket();
		this.run();
	}

	/** An edit or the window's focus brings an idle server back. */
	wake(): void {
		if (this.mode === "idle") this.run();
	}

	private connect(): void {
		if (this.disposed || this.mode !== "running") return;
		this.setStatus({ state: "starting" });
		const startedAt = Date.now();
		const { root, projectName } = this.options;
		const params = initializeParams(root, projectName);
		const folder = params.workspaceFolders?.[0] as { uri: string; name: string };
		const connection = new RpcConnection(this.options.url, {
			onOpen: () => {
				void connection
					.request<InitializeResult>("initialize", params)
					.then((result) => {
						if (this.connection !== connection) return;
						connection.notify("initialized", {});
						this.capabilities = result.capabilities;
						this.setStatus({ state: "ready" });
						for (const doc of this.docs.values()) this.openDocument(doc);
					})
					.catch(() => {
						// An error answer leaves the socket open but useless: show
						// Restart rather than "starting" for ever.
						if (this.connection !== connection) return;
						this.stopSocket();
						this.mode = "stopped";
						this.setStatus({ state: "unavailable" });
					});
			},
			onRequest: (method, requestParams) => {
				if (method === "workspace/diagnostic/refresh") {
					for (const doc of this.docs.values()) this.schedulePull(doc);
				}
				return answerServerRequest(method, requestParams, folder);
			},
			onNotification: (method, notification) => {
				if (method === "textDocument/publishDiagnostics") {
					const { uri, diagnostics } = notification as PublishDiagnosticsParams;
					this.showDiagnostics(uri, diagnostics);
				}
			},
			onClose: (code, reason) => {
				if (this.connection !== connection) return;
				this.connection = null;
				this.capabilities = null;
				this.forgetOpenDocuments();
				const action = closeAction(code);
				this.setStatus(statusAfterClose(action, reason));
				if (action === "disabled") {
					this.mode = "stopped";
					this.options.onDisabled();
				} else if (action === "idle") {
					this.mode = "idle";
				} else if (action === "retry") {
					const wait = this.backoffMs;
					this.backoffMs = nextBackoff(this.backoffMs, Date.now() - startedAt);
					this.retry = setTimeout(() => this.connect(), wait);
				} else {
					this.mode = "stopped";
				}
			},
		});
		this.connection = connection;
	}

	private stopSocket(): void {
		if (this.retry !== undefined) clearTimeout(this.retry);
		this.retry = undefined;
		const connection = this.connection;
		this.connection = null;
		this.capabilities = null;
		connection?.close();
		this.forgetOpenDocuments();
	}

	private forgetOpenDocuments(): void {
		for (const doc of this.docs.values()) {
			doc.open = false;
			this.clearDiagnostics(doc);
		}
	}

	/** Sync a project model to this server for as long as it is open. */
	track(model: Monaco.editor.ITextModel, path: string): void {
		const doc: TrackedDocument = {
			model,
			path,
			uri: serverUri(this.options.root, path),
			open: false,
		};
		this.docs.set(doc.uri, doc);
		if (this.mode === "new") this.run();
		this.wake();
		this.openDocument(doc);
	}

	untrack(model: Monaco.editor.ITextModel): void {
		for (const doc of this.docs.values()) {
			if (doc.model !== model) continue;
			this.closeDocument(doc);
			this.clearDiagnostics(doc);
			this.docs.delete(doc.uri);
		}
	}

	/** One edit, sent as incremental changes (or opened or closed at the size limit). */
	change(
		model: Monaco.editor.ITextModel,
		event: Monaco.editor.IModelContentChangedEvent,
	): void {
		this.wake();
		const doc = this.documentOf(model);
		if (!doc || !this.connection || !this.capabilities) return;
		const fits = modelFitsLimit(model);
		if (!doc.open) {
			if (fits) this.openDocument(doc);
			return;
		}
		if (!fits) {
			this.closeDocument(doc);
			this.clearDiagnostics(doc);
			return;
		}
		this.connection.notify("textDocument/didChange", {
			textDocument: { uri: doc.uri, version: model.getVersionId() },
			contentChanges: event.changes.map(toContentChange),
		});
		this.schedulePull(doc);
	}

	/** Files changed on disk (the project events socket, SPEC.md §11.4). */
	filesChanged(paths: readonly string[]): void {
		if (!this.connection || !this.capabilities || paths.length === 0) return;
		this.connection.notify("workspace/didChangeWatchedFiles", {
			// 2 is Changed: the events socket does not say created or deleted.
			changes: paths.map((path) => ({
				uri: serverUri(this.options.root, path),
				type: 2,
			})),
		});
		for (const doc of this.docs.values()) this.schedulePull(doc);
	}

	documentOf(model: Monaco.editor.ITextModel): TrackedDocument | undefined {
		for (const doc of this.docs.values()) if (doc.model === model) return doc;
		return undefined;
	}

	/** A request for a model this server has open; null when it cannot answer now. */
	async request<T>(
		model: Monaco.editor.ITextModel,
		method: string,
		params: (uri: string) => unknown,
	): Promise<T | null> {
		const doc = this.documentOf(model);
		if (!doc?.open || !this.connection) return null;
		try {
			return await this.connection.request<T>(method, params(doc.uri));
		} catch {
			return null;
		}
	}

	/** The project path of a URI this server sent, or null outside the project. */
	pathOf(uri: string): string | null {
		return pathFromServerUri(this.options.root, uri);
	}

	private openDocument(doc: TrackedDocument): void {
		if (doc.open || !this.connection || !this.capabilities) return;
		const text = doc.model.getValue();
		if (!fitsDocumentLimit(text)) return;
		doc.open = true;
		this.connection.notify("textDocument/didOpen", {
			textDocument: {
				uri: doc.uri,
				languageId: lspLanguageId(doc.model.getLanguageId(), doc.path),
				version: doc.model.getVersionId(),
				text,
			},
		});
		this.schedulePull(doc);
	}

	private closeDocument(doc: TrackedDocument): void {
		if (doc.pull !== undefined) clearTimeout(doc.pull);
		if (!doc.open) return;
		doc.open = false;
		this.connection?.notify("textDocument/didClose", {
			textDocument: { uri: doc.uri },
		});
	}

	/** Servers that only answer pulls (TypeScript 7) are asked after each change. */
	private schedulePull(doc: TrackedDocument): void {
		if (!this.capabilities?.diagnosticProvider) return;
		if (doc.pull !== undefined) clearTimeout(doc.pull);
		doc.pull = setTimeout(() => {
			doc.pull = undefined;
			void this.request<DocumentDiagnosticReport>(
				doc.model,
				"textDocument/diagnostic",
				(uri) => ({ textDocument: { uri } }),
			).then((report) => {
				if (report?.kind === "full" && doc.open)
					this.showDiagnostics(doc.uri, report.items);
			});
		}, PULL_DEBOUNCE_MS);
	}

	private showDiagnostics(uri: string, diagnostics: Diagnostic[]): void {
		const doc = this.docs.get(uri) ?? this.docByPath(uri);
		if (!doc?.open || doc.model.isDisposed()) return;
		const { monaco, projectId } = this.options;
		monaco.editor.setModelMarkers(
			doc.model,
			this.owner,
			diagnostics.map((diagnostic) => toMarker(monaco, diagnostic)),
		);
		useCodeHelpStore.getState().setProblems(
			projectId,
			this.server,
			doc.path,
			diagnostics.map((diagnostic) => toProblem(doc.path, diagnostic)),
		);
	}

	private docByPath(uri: string): TrackedDocument | undefined {
		const path = this.pathOf(uri);
		if (path === null) return undefined;
		for (const doc of this.docs.values()) if (doc.path === path) return doc;
		return undefined;
	}

	private clearDiagnostics(doc: TrackedDocument): void {
		if (!doc.model.isDisposed()) {
			this.options.monaco.editor.setModelMarkers(doc.model, this.owner, []);
		}
		useCodeHelpStore
			.getState()
			.setProblems(this.options.projectId, this.server, doc.path, []);
	}

	dispose(): void {
		this.disposed = true;
		this.stopSocket();
		this.docs.clear();
	}
}
