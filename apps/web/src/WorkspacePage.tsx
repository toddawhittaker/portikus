import { PaneHandle, Skeleton } from "@portikus/ui";
import { Navigate, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Group, Panel, useDefaultLayout } from "react-resizable-panels";
import { useTerminalThemeAttribute } from "./editor/settingsQueries.js";
import { LayoutStoreContext, useLayoutStore } from "./layout/store.js";
import { ProjectPane } from "./projects/ProjectPane.js";
import { useProjects } from "./projects/queries.js";
import { ListeningContext, useListeningQuery } from "./running/services.js";
import { AppHeader } from "./shell/AppHeader.js";
import { DisconnectNotice } from "./shell/DisconnectNotice.js";
import { FilesPane } from "./shell/FilesPane.js";
import { type RightPane, RightPaneContext } from "./shell/rightPane.js";
import { StatusBar } from "./shell/StatusBar.js";
import { type MeUser, useMe } from "./useMe.js";
import { useWorkspaceSocket } from "./useWorkspaceSocket.js";
import { WorkspaceStarting } from "./WorkspaceStarting.js";

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
	return <WorkspaceShell workspaceId={id} user={me.user} />;
}

function WorkspaceShell({ workspaceId, user }: { workspaceId: string; user: MeUser }) {
	const navigate = useNavigate();
	const { workspace, listening, reconnect } = useWorkspaceSocket(workspaceId, () => {
		void navigate({ to: "/session-ended" });
	});
	// The project route is a child of this one, so its parameter may be absent.
	const { projectId } = useParams({ strict: false }) as { projectId?: string };
	const projects = useProjects(workspaceId, "active");
	const project = projects.data?.find((item) => item.id === projectId);
	const running = workspace?.state === "running";
	const layout = useDefaultLayout({ id: "pk-shell", panelIds: PANEL_IDS });
	// The work area and the file tree share one layout store, so a file
	// opened in the tree becomes a tab in the work area (SPEC.md §8.3, §8.4).
	const layoutStore = useLayoutStore(projectId ?? "none");
	const [rightPane, setRightPane] = useState<RightPane>("files");
	const rightPaneApi = useMemo(
		() => ({ pane: rightPane, show: setRightPane }),
		[rightPane],
	);
	// The socket's list is the newer of the two, so it wins once it arrives
	// (SPEC.md §18.2).
	const firstListening = useListeningQuery(workspaceId, running);
	const services = listening ?? firstListening;
	const listeningValue = useMemo(
		() => ({ services: services ?? [], loaded: services !== undefined }),
		[services],
	);
	// The student's terminal colour scheme, applied to the whole shell
	// (issue #239).
	useTerminalThemeAttribute();

	return (
		<LayoutStoreContext.Provider value={projectId ? layoutStore : null}>
			<ListeningContext.Provider value={listeningValue}>
				<RightPaneContext.Provider value={rightPaneApi}>
					<div className="pk-root">
						<AppHeader
							workspaceId={workspaceId}
							user={user}
							workspace={workspace}
							project={project}
						/>
						<Group
							className="pk-shell"
							orientation="horizontal"
							defaultLayout={layout.defaultLayout}
							onLayoutChanged={layout.onLayoutChanged}
						>
							<Panel id="projects" defaultSize={240} minSize={180} maxSize={420}>
								{running ? (
									<ProjectPane workspaceId={workspaceId} currentProjectId={projectId} />
								) : (
									<PaneSkeleton label="Projects" side="left" rows={4} />
								)}
							</Panel>
							<PaneHandle label="Resize project list" />
							<Panel id="work" minSize={360}>
								<main className="pk-work" aria-label="Work area">
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
										/>
									)}
								</main>
							</Panel>
							<PaneHandle label="Resize file tree" />
							<Panel id="files" defaultSize={280} minSize={200} maxSize={480}>
								{running ? (
									<FilesPane workspaceId={workspaceId} project={project} />
								) : (
									<PaneSkeleton label="Files" side="right" rows={9} />
								)}
							</Panel>
						</Group>
						<StatusBar
							workspaceId={workspaceId}
							project={project}
							workspace={workspace}
						/>
					</div>
				</RightPaneContext.Provider>
			</ListeningContext.Provider>
		</LayoutStoreContext.Provider>
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
	const widths = ["70%", "55%", "80%", "60%", "65%", "45%", "70%", "50%", "60%"];
	return (
		<section className={`pk-pane pk-pane--${side}`} aria-label={label} aria-busy="true">
			<div className="pk-pane-head">
				<h2 className="pk-pane-title">{label}</h2>
			</div>
			<div className="pk-pane-body">
				{widths.slice(0, rows).map((width, index) => (
					// The rows are decoration in a fixed order, so the index is a stable key.
					// biome-ignore lint/suspicious/noArrayIndexKey: static decoration
					<div className="pk-skel-row" key={index}>
						<Skeleton variant="block" width="16px" height="16px" />
						<Skeleton variant="text" width={width} />
					</div>
				))}
			</div>
		</section>
	);
}
