/**
 * The open project's code-help manager, for the editors under the workspace
 * page. Null when code help is off (SPEC.md §13.6): no socket, no status.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { CodeHelpManager } from "./manager.js";

export const CodeHelpContext = createContext<CodeHelpManager | null>(null);

export function useCodeHelp(): CodeHelpManager | null {
	return useContext(CodeHelpContext);
}

/** One manager per open project, while code help is on. */
export function useCodeHelpManager(
	workspaceId: string,
	project: { id: string; path: string; name: string } | undefined,
	enabled: boolean,
	openFile: (path: string, line?: number) => void,
): CodeHelpManager | null {
	const [manager, setManager] = useState<CodeHelpManager | null>(null);
	const id = project?.id;
	const root = project?.path;
	const name = project?.name ?? "";
	// A new callback must not restart the servers.
	const openRef = useRef(openFile);
	openRef.current = openFile;
	useEffect(() => {
		if (!enabled || id === undefined || root === undefined) {
			setManager(null);
			return;
		}
		const next = new CodeHelpManager({
			workspaceId,
			projectId: id,
			root,
			projectName: name,
			openFile: (path, line) => openRef.current(path, line),
		});
		setManager(next);
		return () => next.dispose();
	}, [workspaceId, id, root, name, enabled]);
	return manager;
}
