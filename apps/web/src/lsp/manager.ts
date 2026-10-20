/**
 * Code help for one open project: one client per server id, created when the
 * first file of its language opens (SPEC.md §13.6). WorkspacePage owns it.
 */
import type { LanguageServerId } from "@portikus/contracts";
import type * as Monaco from "monaco-editor";
import { wsUrl } from "../api/ws.js";
import { LanguageClient } from "./client.js";
import { registerOpener } from "./opener.js";
import { registerProviders } from "./providers.js";
import { addManager, removeManager } from "./registry.js";
import { type CodeHelpFeature, serverFor, serversForLanguage } from "./servers.js";
import { useCodeHelpStore } from "./store.js";

export interface ManagerOptions {
	workspaceId: string;
	projectId: string;
	/** The project's real path in the workspace. */
	root: string;
	projectName: string;
	/** Opens a project file as a tab, at a line when given. */
	openFile: (path: string, line?: number) => void;
}

export class CodeHelpManager {
	private clients = new Map<LanguageServerId, LanguageClient>();
	private monaco: typeof Monaco | null = null;
	private disabled = false;
	private readonly onFocus = () => {
		for (const client of this.clients.values()) client.wake();
	};

	constructor(readonly options: ManagerOptions) {
		addManager(options.projectId, this);
		window.addEventListener("focus", this.onFocus);
	}

	/** Sync a project model while its editor is open; returns the detach. */
	attach(
		monaco: typeof Monaco,
		model: Monaco.editor.ITextModel,
		path: string,
	): () => void {
		if (this.disabled) return () => {};
		if (this.monaco === null) {
			this.monaco = monaco;
			registerProviders(monaco);
			registerOpener(monaco);
		}
		const clients = serversForLanguage(model.getLanguageId()).map((server) =>
			this.client(server),
		);
		for (const client of clients) client.track(model, path);
		const listener = model.onDidChangeContent((event) => {
			for (const client of clients) client.change(model, event);
		});
		return () => {
			listener.dispose();
			for (const client of clients) client.untrack(model);
		};
	}

	private client(server: LanguageServerId): LanguageClient {
		let client = this.clients.get(server);
		if (client) return client;
		const { workspaceId, projectId, root, projectName } = this.options;
		client = new LanguageClient({
			monaco: this.monaco as typeof Monaco,
			url: wsUrl(
				`/workspaces/${workspaceId}/projects/${projectId}/language-servers/${server}`,
			),
			projectId,
			root,
			projectName,
			server,
			onDisabled: () => this.disable(),
		});
		this.clients.set(server, client);
		return client;
	}

	/** The client that answers this feature for this model, when it is ready. */
	readyClient(
		model: Monaco.editor.ITextModel,
		feature: CodeHelpFeature,
	): LanguageClient | null {
		const server = serverFor(model.getLanguageId(), feature);
		if (server === null) return null;
		const client = this.clients.get(server);
		return client?.ready && client.documentOf(model) ? client : null;
	}

	restart(server: LanguageServerId): void {
		this.clients.get(server)?.restart();
	}

	filesChanged(paths: readonly string[]): void {
		for (const client of this.clients.values()) client.filesChanged(paths);
	}

	/** The site switch is off: no socket again and no status (SPEC.md §13.6). */
	private disable(): void {
		this.disabled = true;
		for (const client of this.clients.values()) client.dispose();
		this.clients.clear();
		useCodeHelpStore.getState().clearProject(this.options.projectId);
	}

	dispose(): void {
		window.removeEventListener("focus", this.onFocus);
		for (const client of this.clients.values()) client.dispose();
		this.clients.clear();
		removeManager(this.options.projectId, this);
		useCodeHelpStore.getState().clearProject(this.options.projectId);
	}
}
