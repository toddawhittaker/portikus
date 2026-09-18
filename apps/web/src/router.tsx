import {
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	redirect,
	type SearchSchemaInput,
	useParams,
} from "@tanstack/react-router";
import { AdminPage } from "./admin/AdminPage.js";
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

const adminRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/admin",
	component: AdminPage,
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
	// `open` and `line` carry "open this file here", which is where the files
	// route and a terminal link land (SPEC.md §14.9).
	// SearchSchemaInput keeps both parameters optional, so every other link to
	// a project stays a plain link.
	validateSearch: (search: Record<string, unknown> & SearchSchemaInput) => ({
		open:
			typeof search.open === "string" && search.open !== "" ? search.open : undefined,
		line: Number(search.line) > 0 ? Number(search.line) : undefined,
	}),
	component: ProjectScreen,
});

function ProjectScreen() {
	const { id, projectId } = useParams({ from: "/workspaces/$id/projects/$projectId" });
	const { open, line } = projectRoute.useSearch();
	const projects = useProjects(id, "active");
	const project = projects.data?.find((item) => item.id === projectId);
	if (!project) return <div className="flex-1" aria-busy="true" />;
	return (
		<WorkArea
			workspaceId={id}
			projectId={project.id}
			projectPath={project.path}
			openPath={open}
			openLine={line}
			onSessionEnded={() => router.navigate({ to: "/session-ended" })}
		/>
	);
}

/**
 * `?path=&line=` opens one file at one line (SPEC.md §14.9). It is the
 * project screen with an instruction, so it hands straight over to that
 * route and lets the work area open the tab.
 */
const filesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/workspaces/$id/projects/$projectId/files",
	validateSearch: (search: Record<string, unknown>) => ({
		path: typeof search.path === "string" ? search.path : "",
		line: Number(search.line) > 0 ? Number(search.line) : 1,
	}),
	beforeLoad: ({ params, search }) => {
		throw redirect({
			to: "/workspaces/$id/projects/$projectId",
			params,
			search: { open: search.path || undefined, line: search.line },
			replace: true,
		});
	},
});

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
	adminRoute,
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
