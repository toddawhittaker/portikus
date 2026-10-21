/**
 * What code help knows, for the editor bar and the Problems tab: each
 * server's state and the diagnostics of the open files (SPEC.md §13.6).
 */
import type { LanguageServerId } from "@portikus/contracts";
import { create } from "zustand";

type ServerState =
	| "starting"
	| "ready"
	| "unavailable"
	| "crashed"
	| "replaced"
	/** Shows nothing: idle, refused, or code help turned off. */
	| "quiet";

export interface ServerStatus {
	state: ServerState;
	/** Extra words for the state, such as a likely out-of-memory crash. */
	detail?: string;
}

export type ProblemSeverity = "error" | "warning" | "info";

export interface Problem {
	path: string;
	/** 1-based, as the editor shows them. */
	line: number;
	column: number;
	severity: ProblemSeverity;
	message: string;
	source?: string;
}

type ByServer = Partial<Record<LanguageServerId, Problem[]>>;

interface CodeHelpState {
	/** By project, then server. */
	status: Record<string, Partial<Record<LanguageServerId, ServerStatus>>>;
	/** By project, then file path, then server. */
	problems: Record<string, Record<string, ByServer>>;
	setStatus: (
		projectId: string,
		server: LanguageServerId,
		status: ServerStatus,
	) => void;
	setProblems: (
		projectId: string,
		server: LanguageServerId,
		path: string,
		problems: Problem[],
	) => void;
	clearProject: (projectId: string) => void;
}

export const useCodeHelpStore = create<CodeHelpState>()((set) => ({
	status: {},
	problems: {},
	setStatus: (projectId, server, status) =>
		set((state) => ({
			status: {
				...state.status,
				[projectId]: { ...state.status[projectId], [server]: status },
			},
		})),
	setProblems: (projectId, server, path, problems) =>
		set((state) => {
			const project = { ...state.problems[projectId] };
			const byServer: ByServer = { ...project[path] };
			// An empty list is dropped, so a long session does not keep a key per file.
			if (problems.length > 0) byServer[server] = problems;
			else delete byServer[server];
			if (Object.keys(byServer).length > 0) project[path] = byServer;
			else delete project[path];
			return { problems: { ...state.problems, [projectId]: project } };
		}),
	clearProject: (projectId) =>
		set((state) => {
			const { [projectId]: _problems, ...problems } = state.problems;
			const { [projectId]: _status, ...status } = state.status;
			return { problems, status };
		}),
}));

/** One server's status, for the editor bar. */
export function useServerStatus(
	projectId: string,
	server: LanguageServerId | null,
): ServerStatus | undefined {
	return useCodeHelpStore((state) =>
		server === null ? undefined : state.status[projectId]?.[server],
	);
}
