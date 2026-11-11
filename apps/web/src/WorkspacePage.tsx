import { THROTTLE_LIFTED_TITLE, type Workspace } from "@portikus/contracts";
import { PaneHandle, Skeleton, useToast } from "@portikus/ui";
import { Navigate, Outlet, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, useDefaultLayout } from "react-resizable-panels";
import {
	useCodeHelpLanguages,
	useEditorSettings,
	useTerminalThemeAttribute,
} from "./editor/settingsQueries.js";
import { ProjectEvents } from "./files/ProjectEvents.js";
import { LayoutStoreContext, useLayoutStore } from "./layout/store.js";
import { LaunchNotice } from "./link/LaunchNotice.js";
import { LiveHelpBar } from "./livehelp/LiveHelpBar.js";
import { CodeHelpContext, useCodeHelpManager } from "./lsp/context.js";
import { usePageTitle } from "./pageTitle.js";
import { ProjectPane } from "./projects/ProjectPane.js";
import { useProjects } from "./projects/queries.js";
import { StarterLaunch } from "./projects/StarterLaunch.js";
import { ListeningContext, useListeningQuery } from "./running/services.js";
import { AppHeader } from "./shell/AppHeader.js";
import { DisconnectNotice, disconnectAnnouncement } from "./shell/DisconnectNotice.js";
import { DRAWER_IDS, type DrawerName, openedTab } from "./shell/drawers.js";
import { FilesPane } from "./shell/FilesPane.js";
import { IdleNotice, idleMinutes, useIdleStopReason } from "./shell/IdleNotice.js";
import { MemoryNotice, memoryAnnouncement } from "./shell/MemoryNotice.js";
import { PaneBar } from "./shell/PaneBar.js";
import {
	ReinstallNotice,
	reinstallAnnouncement,
	useReinstallPackages,
} from "./shell/ReinstallNotice.js";
import {
	type RightPaneApi,
	RightPaneContext,
	showMonitor,
	useRightPaneStore,
} from "./shell/rightPane.js";
import { ScreenReaderToggle } from "./shell/ScreenReaderToggle.js";
import { ShellDrawer, usePhoneLayout } from "./shell/ShellDrawer.js";
import { StatusBar } from "./shell/StatusBar.js";
import { ThrottleNotice, throttleAnnouncement } from "./shell/ThrottleNotice.js";
import { resolveStatus, type WorkspaceDialogMode } from "./shell/WorkspaceDialog.js";
import {
	AgentStatusContext,
	createAgentStatusStore,
} from "./terminal/codingAgentStatus.js";
import { forgetAgentBuild } from "./terminal/terminalFrames.js";
import { useCodingAgentAlerts } from "./terminal/useCodingAgentAlerts.js";
import { type MeUser, useMe } from "./useMe.js";
import { useWorkspaceSocket } from "./useWorkspaceSocket.js";
import { startingPhase, WorkspaceStarting } from "./WorkspaceStarting.js";
import "./pane-placeholder.css";

const PANEL_IDS = ["projects", "work", "files"];

/** The workspace screen. Signed-out and unauthorized people never get here. */
export function WorkspacePage() {
	const { id } = useParams({ from: "/workspaces/$id" });
	const me = useMe();

	if (me.status === "loading") {
		return <div className="pk-root" aria-busy="true" />;
	}
	if (me.status === "anonymous") return <Navigate to="/" />;
	if (me.status === "forbidden") return <Navigate to="/not-authorized" />;
	return <WorkspaceShellWhenSettled workspaceId={id} user={me.user} />;
}

/**
 * Waits for the student's settings so the saved appearance is applied before
 * the shell first paints, even in a browser that has never seen them.
 * A failed load does not hold the shell back.
 */
function WorkspaceShellWhenSettled(props: { workspaceId: string; user: MeUser }) {
	const settings = useEditorSettings();
	// Only the first answer is waited for; a later refetch never hides the shell.
	if (!settings.isFetched) {
		return <div className="pk-root" aria-busy="true" />;
	}
	return <WorkspaceShell {...props} />;
}

function WorkspaceShell({ workspaceId, user }: { workspaceId: string; user: MeUser }) {
	// Held here so unread marks survive switching projects.
	const [agentStatus] = useState(() => createAgentStatusStore());
	const workRef = useRef<HTMLElement>(null);
	// The project route is a child of this one, so its parameter may be absent.
	const { projectId } = useParams({ strict: false }) as { projectId?: string };
	const projects = useProjects(workspaceId, "active");
	const handleCodingAgents = useCodingAgentAlerts(
		agentStatus,
		workspaceId,
		projectId,
		projects.data,
		workRef,
	);
	const { workspace, listening, reconnect, sendActivity } = useWorkspaceSocket(
		workspaceId,
		handleCodingAgents,
	);
	useEffect(() => {
		const refresh = () => agentStatus.refresh();
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [agentStatus]);
	// A throttle is dismissed for the page's life; a new one shows again (ADR 0032).
	const [dismissedThrottleAt, setDismissedThrottleAt] = useState<string | null>(null);
	const [dismissedMemoryAt, setDismissedMemoryAt] = useState<string | null>(null);
	useThrottleLiftToast(workspace);
	const idleStopReason = useIdleStopReason(workspace);
	// The status bar, the error screen and the throttle notice all open this dialog.
	const [workspaceDialog, setWorkspaceDialog] = useState<WorkspaceDialogMode>("closed");
	const project = projects.data?.find((item) => item.id === projectId);
	usePageTitle(project?.name ?? "");
	const running = workspace?.state === "running";
	const { starter } = useSearch({ from: "/workspaces/$id" });
	// A stop ends the terminals, so the next start is not an upgrade (SPEC.md §22.5).
	useEffect(() => {
		if (workspace && !running) forgetAgentBuild(workspaceId);
	}, [workspace, running, workspaceId]);
	// Skeletons promise that something is loading; a stopped workspace loads nothing.
	const phase = startingPhase(workspace);
	const loading =
		phase === "connecting" || phase === "starting" || phase === "restoring";
	const layout = useDefaultLayout({
		id: "pk-shell",
		panelIds: PANEL_IDS,
		// The squeeze of a narrow window must not become the wide layout's widths.
		onlySaveAfterUserInteractions: true,
	});
	// The work area and the file tree share one layout store, so a file
	// opened in the tree becomes a tab in the work area (SPEC.md §8.3, §8.4).
	const layoutStore = useLayoutStore(projectId ?? "none");
	// At phone widths the side panes are drawers, one open at a time (SPEC.md §8.1).
	const phone = usePhoneLayout();
	const [drawer, setDrawer] = useState<DrawerName | null>(null);
	const projectsButton = useRef<HTMLButtonElement>(null);
	const filesButton = useRef<HTMLButtonElement>(null);
	const closeDrawer = () => setDrawer(null);
	// A drawer left open does not reappear when the window narrows again.
	useEffect(() => {
		if (!phone) setDrawer(null);
	}, [phone]);
	// Choosing a project or opening a file shows the work area.
	useEffect(() => {
		if (projectId !== undefined) setDrawer(null);
	}, [projectId]);
	useEffect(
		() =>
			layoutStore.subscribe((state, previous) => {
				if (openedTab(previous, state))
					setDrawer((open) => (open === "files" ? null : open));
			}),
		[layoutStore],
	);
	const paneStore = useRightPaneStore();
	// A notice or tab asking for a right-pane surface opens its drawer, or nothing would show.
	const rightPaneApi = useMemo<RightPaneApi>(
		() =>
			phone
				? {
						...paneStore,
						show: (pane) => {
							paneStore.show(pane);
							setDrawer("files");
						},
					}
				: paneStore,
		[phone, paneStore],
	);
	const memoryFlag = workspace?.memoryFlag ?? null;
	const showMemoryNotice = memoryFlag !== null && memoryFlag.at !== dismissedMemoryAt;
	const reinstallPackages = useReinstallPackages(workspaceId, running);
	// The socket's list is the newer of the two, so it wins once it arrives
	// (SPEC.md §18.2).
	const firstListening = useListeningQuery(workspaceId, running);
	const services = listening ?? firstListening;
	const listeningValue = useMemo(
		() => ({ services: services ?? [], loaded: services !== undefined }),
		[services],
	);
	// The student's terminal colour scheme, applied to the whole shell.
	useTerminalThemeAttribute();
	// One code-help manager for the open project (SPEC.md §13.6).
	const codeHelp = useCodeHelpManager(
		workspaceId,
		running ? project : undefined,
		useCodeHelpLanguages(),
		(path, line) => layoutStore.getState().openFile(path, { line }),
	);

	const shell = (
		<div className="pk-root">
			<ScreenReaderToggle />
			<AppHeader
				workspaceId={workspaceId}
				user={user}
				workspace={workspace}
				project={project}
			/>
			<LaunchNotice displayName={user.displayName} />
			{/* Shown while stopped too: a session outlasts a stop, and only the student ends it early. */}
			<LiveHelpBar workspaceId={workspaceId} fallbackFocus={workRef} />
			<StarterLaunch workspaceId={workspaceId} starterId={starter} running={running} />
			<Group
				className="pk-shell"
				orientation="horizontal"
				// The library hit-tests panel edges even without handles, and would swallow taps on a phone.
				disabled={phone}
				defaultLayout={layout.defaultLayout}
				onLayoutChanged={layout.onLayoutChanged}
			>
				<Panel id="projects" defaultSize={264} minSize={180} maxSize={420}>
					<ShellDrawer
						id={DRAWER_IDS.projects}
						side="left"
						label="Projects"
						phone={phone}
						open={drawer === "projects"}
						onClose={closeDrawer}
						opener={projectsButton}
					>
						{running ? (
							<ProjectPane workspaceId={workspaceId} currentProjectId={projectId} />
						) : loading ? (
							<PaneSkeleton label="Projects" side="left" rows={4} />
						) : (
							<PaneWaiting
								label="Projects"
								side="left"
								text="Start your workspace to see your projects"
							/>
						)}
					</ShellDrawer>
				</Panel>
				{phone ? null : <PaneHandle label="Resize project list" />}
				<Panel id="work" minSize={360}>
					<main
						className="pk-work"
						aria-label="Work area"
						ref={workRef}
						// Takes focus when a notice holding it is dismissed.
						tabIndex={-1}
					>
						{/* Always mounted, so a new throttle is announced (SPEC.md §25.8). */}
						<span
							role="status"
							aria-live="polite"
							className="sr-only"
							data-testid="throttle-announce"
						>
							{workspace?.cpuThrottle &&
							workspace.cpuThrottle.at !== dismissedThrottleAt
								? throttleAnnouncement(workspace.cpuThrottle)
								: ""}
						</span>
						{workspace?.cpuThrottle &&
							workspace.cpuThrottle.at !== dismissedThrottleAt && (
								<ThrottleNotice
									throttle={workspace.cpuThrottle}
									onOpenWorkspace={() =>
										// A restart cannot run while the workspace is already changing.
										setWorkspaceDialog(
											resolveStatus(workspace).moving ? "open" : "restart",
										)
									}
									onShowMonitor={() => showMonitor(rightPaneApi, "cpu")}
									fallbackFocus={workRef}
									onDismiss={() => {
										setDismissedThrottleAt(workspace.cpuThrottle?.at ?? null);
										workRef.current?.focus();
									}}
								/>
							)}
						{/* Always mounted, so a new memory flag is announced (SPEC.md §25.8). */}
						<span
							role="status"
							aria-live="polite"
							className="sr-only"
							data-testid="memory-announce"
						>
							{showMemoryNotice ? memoryAnnouncement(memoryFlag) : ""}
						</span>
						{showMemoryNotice && (
							<MemoryNotice
								flag={memoryFlag}
								onShowMonitor={() => showMonitor(rightPaneApi, "memory")}
								fallbackFocus={workRef}
								onDismiss={() => {
									setDismissedMemoryAt(memoryFlag.at);
									workRef.current?.focus();
								}}
							/>
						)}
						{/* Always mounted, so the reinstall list is announced (SPEC.md §25.8). */}
						<span
							role="status"
							aria-live="polite"
							className="sr-only"
							data-testid="reinstall-announce"
						>
							{running ? reinstallAnnouncement(reinstallPackages) : ""}
						</span>
						<ReinstallNotice
							workspaceId={workspaceId}
							running={running}
							fallbackFocus={workRef}
						/>
						{workspace?.idleStopAt && (
							<IdleNotice
								deadline={workspace.idleStopAt}
								minutes={idleMinutes(workspace)}
								onKeepWorking={sendActivity}
								fallbackFocus={workRef}
							/>
						)}
						{/* Always mounted, with a fixed stop time, so it is heard once (SPEC.md §25.8). */}
						<span
							role="status"
							aria-live="polite"
							className="sr-only"
							data-testid="disconnect-announce"
						>
							{workspace?.shutdownDeadline
								? disconnectAnnouncement(workspace.shutdownDeadline)
								: ""}
						</span>
						{workspace?.shutdownDeadline && (
							<DisconnectNotice
								deadline={workspace.shutdownDeadline}
								onReconnect={reconnect}
							/>
						)}
						{running ? (
							<Outlet />
						) : (
							<WorkspaceStarting
								workspaceId={workspaceId}
								workspace={workspace}
								idleStop={idleStopReason}
								onOpenWorkspace={() => setWorkspaceDialog("open")}
							/>
						)}
					</main>
				</Panel>
				{phone ? null : <PaneHandle label="Resize file tree" />}
				<Panel id="files" defaultSize={360} minSize={200} maxSize={480}>
					<ShellDrawer
						id={DRAWER_IDS.files}
						side="right"
						label="Files"
						phone={phone}
						open={drawer === "files"}
						onClose={closeDrawer}
						opener={filesButton}
					>
						{running ? (
							<FilesPane workspaceId={workspaceId} project={project} />
						) : loading ? (
							<PaneSkeleton label="Files" side="right" rows={9} />
						) : (
							<PaneWaiting
								label="Files"
								side="right"
								text="Start your workspace to see its files"
							/>
						)}
					</ShellDrawer>
				</Panel>
			</Group>
			<StatusBar
				workspaceId={workspaceId}
				project={project}
				workspace={workspace}
				dialog={workspaceDialog}
				onDialogChange={setWorkspaceDialog}
			/>
			<PaneBar
				drawers={{
					open: drawer,
					onOpen: setDrawer,
					projectsRef: projectsButton,
					filesRef: filesButton,
				}}
			/>
		</div>
	);

	return (
		<LayoutStoreContext.Provider value={projectId ? layoutStore : null}>
			<ListeningContext.Provider value={listeningValue}>
				<AgentStatusContext.Provider value={agentStatus}>
					<RightPaneContext.Provider value={rightPaneApi}>
						{/* One events socket for the open project, whatever pane is showing (SPEC.md §11.4). */}
						<CodeHelpContext.Provider value={codeHelp}>
							<ProjectEvents
								workspaceId={workspaceId}
								projectId={running ? project?.id : undefined}
								layoutStore={layoutStore}
								onFilesChanged={(paths) => codeHelp?.filesChanged(paths)}
							>
								{shell}
							</ProjectEvents>
						</CodeHelpContext.Provider>
					</RightPaneContext.Provider>
				</AgentStatusContext.Provider>
			</ListeningContext.Provider>
		</LayoutStoreContext.Provider>
	);
}

/**
 * Says so at once when a throttle this page was showing goes away (SPEC.md §19.4).
 */
function useThrottleLiftToast(workspace: Workspace | null) {
	const toast = useToast();
	const throttledAt = useRef<string | null>(null);
	useEffect(() => {
		// A missing workspace is a reconnect, not a lift.
		if (!workspace) return;
		const now = workspace.cpuThrottle?.at ?? null;
		// A stop or restart clears the throttle too; that is not "back to full speed".
		if (throttledAt.current !== null && now === null && workspace.state === "running") {
			// The worker writes the history row for an idle lift, page open or not.
			toast.show({ tone: "success", title: THROTTLE_LIFTED_TITLE, unrecorded: true });
		}
		throttledAt.current = now;
	}, [workspace, toast]);
}

// Widths of a pane's placeholder rows, shared by the starting and the waiting panes.
const ROW_WIDTHS = ["70%", "55%", "80%", "60%", "65%", "45%", "70%", "50%", "60%"];

/** Placeholder rows in a pane's list shape; still ones say nothing is loading. */
function PaneRows({ rows, still = false }: { rows: number; still?: boolean }) {
	return (
		<div
			className={still ? "pk-skel-rows is-still" : "pk-skel-rows"}
			aria-hidden="true"
		>
			{ROW_WIDTHS.slice(0, rows).map((width, index) => (
				// The rows are decoration in a fixed order, so the index is a stable key.
				// biome-ignore lint/suspicious/noArrayIndexKey: static decoration
				<div className="pk-skel-row" key={index}>
					<Skeleton variant="block" width="16px" height="16px" />
					<Skeleton variant="text" width={width} />
				</div>
			))}
		</div>
	);
}

/** A pane that is waiting for the workspace (design/mockups/WorkspaceStarting). */
function PaneSkeleton({
	label,
	side,
	rows,
}: {
	label: string;
	side: "left" | "right";
	rows: number;
}) {
	return (
		<section className={`pk-pane pk-pane--${side}`} aria-label={label} aria-busy="true">
			<div className="pk-pane-head">
				<h2 className="pk-pane-title">{label}</h2>
			</div>
			<div className="pk-pane-body">
				<PaneRows rows={rows} />
			</div>
		</section>
	);
}

/** A side pane while the workspace is stopped or failed: nothing is loading. */
function PaneWaiting({
	label,
	side,
	text,
}: {
	label: string;
	side: "left" | "right";
	text: string;
}) {
	return (
		<section className={`pk-pane pk-pane--${side}`} aria-label={label}>
			<div className="pk-pane-head">
				<h2 className="pk-pane-title">{label}</h2>
			</div>
			<div className="pk-pane-body pk-pane-waiting">
				<PaneRows rows={side === "left" ? 4 : 7} still={true} />
				<p className="pk-pane-waiting-text">{text}</p>
			</div>
		</section>
	);
}
