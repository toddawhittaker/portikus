/**
 * The language servers the agent can start, one entry per server id
 * (SPEC.md §13.6). Adding a server is one entry here plus the contract value.
 */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LanguageServerId } from "@portikus/contracts";

/** How to start one server for one project. */
interface ServerCommand {
	command: string;
	args: string[];
	/** Added to, or replacing, the agent's environment. */
	env: Record<string, string>;
}

export interface LanguageServerEntry {
	id: LanguageServerId;
	/** Counted toward MAX_LANGUAGE_SERVERS_PER_WORKSPACE. */
	counted: boolean;
	/** Merged over the browser's `initializationOptions`; ours win. */
	initializationOptions: Record<string, unknown>;
	/** Merged over the browser's client capabilities; ours win. */
	clientCapabilities: Record<string, unknown>;
	/** The command for a project, or null when the server is not installed. */
	resolve: (projectPath: string) => Promise<ServerCommand | null>;
}

/** Memory cap per server, as a heap or Go limit; the load test may tune it (SPEC.md §25.2). */
const SERVER_MEMORY_MIB = 1024;

const require = createRequire(import.meta.url);

/** The agent tree's own root: `dist/..` when packaged, `src/..` in development. */
const AGENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function executable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * PATH with the project's virtual environment first, so pyright's
 * interpreter lookup finds the packages the student installed there.
 */
export async function pythonPath(
	projectPath: string,
	basePath: string,
): Promise<string> {
	for (const name of [".venv", "venv"]) {
		const bin = join(projectPath, name, "bin");
		if (await isDirectory(bin)) return `${bin}:${basePath}`;
	}
	return basePath;
}

async function resolvePyright(projectPath: string): Promise<ServerCommand | null> {
	let script: string;
	try {
		script = join(
			dirname(require.resolve("pyright/package.json")),
			"langserver.index.js",
		);
	} catch {
		return null;
	}
	return {
		command: process.execPath,
		args: [`--max-old-space-size=${SERVER_MEMORY_MIB}`, script, "--stdio"],
		env: { PATH: await pythonPath(projectPath, process.env.PATH ?? "") },
	};
}

/** TypeScript 7's native binary; its own lookup is not in the package's exports. */
async function resolveTypeScript(): Promise<ServerCommand | null> {
	let exe: string;
	try {
		const lib = join(dirname(require.resolve("typescript/package.json")), "lib");
		const module = (await import(pathToFileURL(join(lib, "getExePath.js")).href)) as {
			default: () => string;
		};
		exe = module.default();
	} catch {
		return null;
	}
	if (!(await executable(exe))) return null;
	return {
		command: exe,
		args: ["--lsp", "--stdio"],
		// The Go runtime's soft memory limit: it collects harder near it, and
		// the container's limit stays the hard ceiling.
		env: { GOMEMLIMIT: `${SERVER_MEMORY_MIB}MiB` },
	};
}

/** Installed by the package beside the agent; absent in development. */
export const RUFF_PATH = join(AGENT_ROOT, "bin", "ruff");

async function resolveRuff(): Promise<ServerCommand | null> {
	if (!(await executable(RUFF_PATH))) return null;
	return { command: RUFF_PATH, args: ["server"], env: {} };
}

export const LANGUAGE_SERVERS: Record<LanguageServerId, LanguageServerEntry> = {
	python: {
		id: "python",
		counted: true,
		initializationOptions: {},
		clientCapabilities: {},
		resolve: resolvePyright,
	},
	typescript: {
		id: "typescript",
		counted: true,
		// Automatic type acquisition runs npm. The server reads that setting
		// only from initializationOptions when the client cannot answer
		// workspace/configuration, and from the client's answer otherwise.
		initializationOptions: {
			userPreferences: { automaticTypeAcquisitionEnabled: false },
		},
		clientCapabilities: { workspace: { configuration: false } },
		resolve: resolveTypeScript,
	},
	ruff: {
		id: "ruff",
		counted: false,
		initializationOptions: { settings: { lint: { enable: false } } },
		clientCapabilities: {},
		resolve: resolveRuff,
	},
};
