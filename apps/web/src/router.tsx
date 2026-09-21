import { ProjectPath } from "@portikus/contracts";
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
import { MIN_PREVIEW_PORT } from "./links.js";
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

/**
 * A file path from a link is only ever a path inside the project (SPEC.md
 * §24.6); anything else opens nothing rather than being sent to the agent.
 */
function safePath(value: unknown): string | undefined {
	const parsed = ProjectPath.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

/** A port from a link is a port a preview may use (SPEC.md §14.7). */
function safePort(value: unknown): number | undefined {
	const port = Number(value);
	return Number.isInteger(port) && port >= MIN_PREVIEW_PORT && port <= 65535
		? port
		: undefined;
}

/** A line number from a link is a whole line, counted from one. */
function safeLine(value: unknown): number | undefined {
	const line = Number(value);
	return Number.isInteger(line) && line >= 1 ? line : undefined;
}

const projectRoute = createRoute({
	getParentRoute: () => workspaceRoute,
	path: "/projects/$projectId",
	// `open` and `line` carry "open this file here", which is where the files
	// route and a terminal link land (SPEC.md §14.9).
	// SearchSchemaInput keeps both parameters optional, so every other link to
	// a project stays a plain link.
	validateSearch: (search: Record<string, unknown> & SearchSchemaInput) => ({
		open: safePath(search.open),
		line: safeLine(search.line),
		preview: safePort(search.preview),
	}),
	component: ProjectScreen,
});

function ProjectScreen() {
	const { id, projectId } = useParams({ from: "/workspaces/$id/projects/$projectId" });
	const { open, line, preview } = projectRoute.useSearch();
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
			openPreviewPort={preview}
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
		path: safePath(search.path),
		line: safeLine(search.line),
	}),
	beforeLoad: ({ params, search }) => {
		throw redirect({
			to: "/workspaces/$id/projects/$projectId",
			params,
			search: { open: search.path, line: search.line },
			replace: true,
		});
	},
});

/**
 * `/preview/<port>` is the project screen with an instruction, the way the
 * files route is: it hands over and lets the work area open the tab
 * (SPEC.md §14.6, §14.9).
 */
const previewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/workspaces/$id/projects/$projectId/preview/$port",
	beforeLoad: ({ params }) => {
		throw redirect({
			to: "/workspaces/$id/projects/$projectId",
			params: { id: params.id, projectId: params.projectId },
			search: { preview: safePort(params.port) },
			replace: true,
		});
	},
});

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
