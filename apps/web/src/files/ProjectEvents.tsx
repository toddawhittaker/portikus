/**
 * Holds the open project's events socket for as long as the project is on
 * screen, whichever right-pane tab is showing, so on-disk changes and
 * browser-open requests are never missed (SPEC.md §11.4,
 * BROWSER-HANDLING.md §18).
 */
import type { BrowserOpenRequest } from "@portikus/contracts";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import type { LayoutStore } from "../layout/store.js";
import { BrowserOpenDialog } from "./BrowserOpenDialog.js";
import { useProjectEvents } from "./useProjectEvents.js";

/** True when the project is too large to watch live (SPEC.md §11.4). */
const WatchLimitedContext = createContext(false);

export function useWatchLimited(): boolean {
	return useContext(WatchLimitedContext);
}

/**
 * Always mounted around the shell, so the shell is never remounted when a
 * project opens; the socket itself lives only while `projectId` is set.
 */
export function ProjectEvents({
	workspaceId,
	projectId,
	layoutStore,
	children,
}: {
	workspaceId: string;
	/** The open project, or undefined when none is open or the workspace is down. */
	projectId: string | undefined;
	layoutStore: LayoutStore;
	children: ReactNode;
}) {
	const [limited, setLimited] = useState(false);
	return (
		<WatchLimitedContext.Provider value={limited}>
			{children}
			{projectId ? (
				<ProjectSocket
					key={projectId}
					workspaceId={workspaceId}
					projectId={projectId}
					layoutStore={layoutStore}
					onLimited={setLimited}
				/>
			) : null}
		</WatchLimitedContext.Provider>
	);
}

function ProjectSocket({
	workspaceId,
	projectId,
	layoutStore,
	onLimited,
}: {
	workspaceId: string;
	projectId: string;
	layoutStore: LayoutStore;
	onLimited: (limited: boolean) => void;
}) {
	const [browserOpens, setBrowserOpens] = useState<BrowserOpenRequest[]>([]);
	const seenOpens = useRef(new Set<string>());
	// Each dialog in a run of queued requests would otherwise remember the
	// previous dialog's removed button as its opener (SPEC.md §25.8).
	const queued = useRef(0);
	const opener = useRef<HTMLElement | null>(null);
	const { limited } = useProjectEvents(workspaceId, projectId, (request) => {
		// The agent may resend a request the page already queued.
		if (seenOpens.current.has(request.requestId)) return;
		seenOpens.current.add(request.requestId);
		if (queued.current === 0) {
			const active = document.activeElement;
			opener.current = active instanceof HTMLElement ? active : null;
		}
		queued.current += 1;
		setBrowserOpens((queue) => [...queue, request]);
	});
	useEffect(() => {
		onLimited(limited);
		return () => onLimited(false);
	}, [limited, onLimited]);
	return browserOpens[0] ? (
		<BrowserOpenDialog
			request={browserOpens[0]}
			workspaceId={workspaceId}
			projectId={projectId}
			onOpenPreview={(port) => layoutStore.getState().openPreview(port)}
			returnFocusTo={() => opener.current}
			onClose={() => {
				queued.current -= 1;
				setBrowserOpens((queue) => queue.slice(1));
			}}
		/>
	) : null;
}
