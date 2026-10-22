/**
 * The open project's code-help manager, for the editors under the workspace
 * page. Null when code help is off for every language (SPEC.md §13.6): no
 * socket, no status.
 */
import type { CodeHelpLanguage } from "@portikus/contracts";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { CodeHelpManager } from "./manager.js";

export const CodeHelpContext = createContext<CodeHelpManager | null>(null);

export function useCodeHelp(): CodeHelpManager | null {
	return useContext(CodeHelpContext);
}

/**
 * One manager per open project, while code help is on for some language. A
 * changed set of languages makes a new manager; a refetch of the same set does not.
 */
export function useCodeHelpManager(
	workspaceId: string,
	project: { id: string; path: string; name: string } | undefined,
	languages: ReadonlySet<CodeHelpLanguage>,
	openFile: (path: string, line?: number) => void,
): CodeHelpManager | null {
	const [manager, setManager] = useState<CodeHelpManager | null>(null);
	const id = project?.id;
	const root = project?.path;
	const name = project?.name ?? "";
	// A new callback must not restart the servers.
	const openRef = useRef(openFile);
	openRef.current = openFile;
	const languagesRef = useRef(languages);
	languagesRef.current = languages;
	const key = [...languages].sort().join(",");
	// biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the set, so a new Set of the same languages keeps the servers
	useEffect(() => {
		if (languagesRef.current.size === 0 || id === undefined || root === undefined) {
			setManager(null);
			return;
		}
		const next = new CodeHelpManager({
			workspaceId,
			projectId: id,
			root,
			projectName: name,
			languages: languagesRef.current,
			openFile: (path, line) => openRef.current(path, line),
		});
		setManager(next);
		return () => next.dispose();
	}, [workspaceId, id, root, name, key]);
	return manager;
}
