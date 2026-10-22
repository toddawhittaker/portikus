/**
 * Code help follows the languages the site has on, one language at a time
 * (SPEC.md §13.6): a file of a language that is off gets no socket, and a
 * refusal by the API stops only its own language.
 */
import type { CodeHelpLanguage, LanguageServerId } from "@portikus/contracts";
import type * as Monaco from "monaco-editor";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ClientOptions } from "./client.js";
import { CodeHelpManager } from "./manager.js";
import { useCodeHelpStore } from "./store.js";

const created = vi.hoisted(
	() =>
		[] as Array<{
			options: ClientOptions;
			track: ReturnType<typeof vi.fn>;
			untrack: ReturnType<typeof vi.fn>;
			dispose: ReturnType<typeof vi.fn>;
		}>,
);

vi.mock("./client.js", () => ({
	LanguageClient: class {
		track = vi.fn();
		untrack = vi.fn();
		change = vi.fn();
		dispose = vi.fn();
		wake = vi.fn();
		constructor(readonly options: ClientOptions) {
			created.push(this);
		}
	},
}));
vi.mock("./providers.js", () => ({ registerProviders: vi.fn() }));
vi.mock("./opener.js", () => ({ registerOpener: vi.fn() }));
vi.mock("../api/ws.js", () => ({ wsUrl: (path: string) => `ws://test${path}` }));

const PROJECT = "project-1";

function manager(...languages: CodeHelpLanguage[]) {
	return new CodeHelpManager({
		workspaceId: "w1",
		projectId: PROJECT,
		root: "/home/student/projects/p",
		projectName: "p",
		languages: new Set(languages),
		openFile: vi.fn(),
	});
}

function model(language: string) {
	return {
		getLanguageId: () => language,
		onDidChangeContent: () => ({ dispose: vi.fn() }),
	} as unknown as Monaco.editor.ITextModel;
}

const monaco = {} as typeof Monaco;

const serversOpened = () => created.map((client) => client.options.server).sort();

beforeEach(() => {
	created.length = 0;
	useCodeHelpStore.setState({ status: {}, problems: {}, viewers: {} });
});

afterEach(() => {
	vi.clearAllMocks();
});

test("a file of a language that is off gets no client, so no socket", () => {
	const help = manager("typescript");
	const detach = help.attach(monaco, model("python"), "a.py");
	expect(created).toHaveLength(0);
	expect(help.allows("python")).toBe(false);
	expect(help.allows("ruff")).toBe(false);
	// Detaching what was never attached is harmless.
	detach();
	help.dispose();
});

test("the languages that are on keep working beside one that is off", () => {
	const help = manager("typescript");
	help.attach(monaco, model("typescript"), "a.ts");
	help.attach(monaco, model("javascript"), "b.js");
	expect(serversOpened()).toEqual(["typescript"]);
	expect(created[0]?.track).toHaveBeenCalledTimes(2);
	help.dispose();
});

test("Python on starts the Python server and Ruff together", () => {
	const help = manager("python");
	help.attach(monaco, model("python"), "a.py");
	expect(serversOpened()).toEqual(["python", "ruff"]);
	expect(help.allows("typescript")).toBe(false);
	help.dispose();
});

test("a file of a language with no code help gets no client", () => {
	const help = manager("python", "typescript");
	help.attach(monaco, model("plaintext"), "notes.txt");
	expect(created).toHaveLength(0);
	help.dispose();
});

function refuse(server: LanguageServerId) {
	const client = created.find((item) => item.options.server === server);
	client?.options.onDisabled();
}

test("a refusal stops that language only, Python and Ruff together", () => {
	const help = manager("python", "typescript");
	help.attach(monaco, model("python"), "a.py");
	help.attach(monaco, model("typescript"), "a.ts");
	useCodeHelpStore.getState().setStatus(PROJECT, "ruff", { state: "ready" });
	useCodeHelpStore.getState().setStatus(PROJECT, "typescript", { state: "ready" });

	refuse("python");

	const byServer = (server: LanguageServerId) =>
		created.find((item) => item.options.server === server);
	expect(byServer("python")?.dispose).toHaveBeenCalledTimes(1);
	expect(byServer("ruff")?.dispose).toHaveBeenCalledTimes(1);
	expect(byServer("typescript")?.dispose).not.toHaveBeenCalled();
	expect(help.allows("python")).toBe(false);
	expect(help.allows("typescript")).toBe(true);
	const status = useCodeHelpStore.getState().status[PROJECT];
	expect(status?.ruff).toBeUndefined();
	expect(status?.typescript).toEqual({ state: "ready" });
	help.dispose();
});

test("after a refusal the language stays off, and the others still attach", () => {
	const help = manager("python", "typescript");
	help.attach(monaco, model("python"), "a.py");
	refuse("python");
	const before = created.length;

	help.attach(monaco, model("python"), "b.py");
	expect(created).toHaveLength(before);

	help.attach(monaco, model("typescript"), "b.ts");
	expect(created).toHaveLength(before + 1);
	expect(created.at(-1)?.options.server).toBe("typescript");
	help.dispose();
});
