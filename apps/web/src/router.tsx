import {
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	useParams,
} from "@tanstack/react-router";
import { ComingLater } from "./ComingLater.js";
import { NotAuthorized } from "./pages/NotAuthorized.js";
import { SessionEnded } from "./pages/SessionEnded.js";
import { SignIn } from "./pages/SignIn.js";
import { ProjectIndex } from "./projects/ProjectIndex.js";
import { useProjects } from "./projects/queries.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { WorkArea } from "./work/WorkArea.js";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: SignIn,
});

const sessionEndedRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/session-ended",
	component: SessionEnded,
});

const notAuthorizedRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/not-authorized",
	component: NotAuthorized,
});

/** The shell: header, three panes and status bar. Its children fill the centre. */
const workspaceRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/workspaces/$id",
	component: WorkspacePage,
});

const workspaceIndexRoute = createRoute({
	getParentRoute: () => workspaceRoute,
	path: "/",
	component: ProjectIndex,
});

const projectRoute = createRoute({
	getParentRoute: () => workspaceRoute,
	path: "/projects/$projectId",
	component: ProjectScreen,
});

function ProjectScreen() {
	const { id, projectId } = useParams({ from: "/workspaces/$id/projects/$projectId" });
	const projects = useProjects(id, "active");
	const project = projects.data?.find((item) => item.id === projectId);
	if (!project) return <div className="flex-1" aria-busy="true" />;
	return (
		<WorkArea
			workspaceId={id}
			projectId={project.id}
			projectPath={project.path}
			onSessionEnded={() => router.navigate({ to: "/session-ended" })}
		/>
	);
}

const filesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/workspaces/$id/projects/$projectId/files",
	validateSearch: (search: Record<string, unknown>) => ({
		path: typeof search.path === "string" ? search.path : "",
		line: Number(search.line) > 0 ? Number(search.line) : 1,
	}),
	component: FilesPlaceholder,
});

function FilesPlaceholder() {
	const { id } = filesRoute.useParams();
	const { path, line } = filesRoute.useSearch();
	return (
		<ComingLater
			title="Files"
			workspaceId={id}
			detail={`Opening ${path || "a file"} at line ${line} is not built yet.`}
		/>
	);
}

const previewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/workspaces/$id/projects/$projectId/preview/$port",
	component: PreviewPlaceholder,
});

function PreviewPlaceholder() {
	const { id, port } = previewRoute.useParams();
	return (
		<ComingLater
			title="Preview"
			workspaceId={id}
			detail={`The preview for port ${port} is not built yet.`}
		/>
	);
}

export const routeTree = rootRoute.addChildren([
	indexRoute,
	sessionEndedRoute,
	notAuthorizedRoute,
	workspaceRoute.addChildren([workspaceIndexRoute, projectRoute]),
	filesRoute,
	previewRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
