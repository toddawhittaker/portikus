import { LinkError, ProjectPath } from "@portikus/contracts";
import {
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	redirect,
	type SearchSchemaInput,
	useNavigate,
	useParams,
	useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { AcceptableUsePage } from "./acceptable-use/AcceptableUsePage.js";
import { ADMIN_TABS, AdminPage } from "./admin/AdminPage.js";
import { sanitizeLogSearch } from "./admin/logs/filters.js";
import { CourseListPage, CourseMembersPage } from "./course/CoursePage.js";
import { LinkPage } from "./link/LinkPage.js";
import { LinkStartPage } from "./link/LinkStartPage.js";
import { useLinkedReload } from "./link/useLinkedReload.js";
import { MIN_PREVIEW_PORT, UUID } from "./links.js";
import { NotAuthorized } from "./pages/NotAuthorized.js";
import { NotFound } from "./pages/NotFound.js";
import { SessionEnded } from "./pages/SessionEnded.js";
import { SignIn } from "./pages/SignIn.js";
import { Unlinked } from "./pages/Unlinked.js";
import { ChangePasswordPage } from "./password/ChangePasswordPage.js";
import { ProjectIndex } from "./projects/ProjectIndex.js";
import { useProjects } from "./projects/queries.js";
import { gatePath, useMe } from "./useMe.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { WorkArea } from "./work/WorkArea.js";

const rootRoute = createRootRoute({
	component: function Root() {
		useLinkedReload();
		const me = useMe();
		const navigate = useNavigate();
		const pathname = useRouterState({ select: (state) => state.location.pathname });
		// The server refuses everything else anyway (SPEC.md section 5.3).
		const gate = gatePath(me);
		const sendAway = gate !== null && pathname !== gate;
		useEffect(() => {
			if (sendAway && gate) void navigate({ to: gate, replace: true });
		}, [sendAway, gate, navigate]);
		if (sendAway) return <div className="pk-root" aria-busy="true" />;
		return <Outlet />;
	},
	notFoundComponent: NotFound,
});

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

const changePasswordRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/change-password",
	component: ChangePasswordPage,
});

const acceptableUseRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/acceptable-use",
	component: AcceptableUsePage,
});

const unlinkedRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/unlinked",
	component: Unlinked,
});

const notAuthorizedRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/not-authorized",
	component: NotAuthorized,
});

/** The SSO sign-in lands here to confirm a link (docs/archive/epics/EPIC-13-1.md, "The flow" step 4). */
const linkRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/link",
	validateSearch: (search: Record<string, unknown> & SearchSchemaInput) => ({
		error: LinkError.safeParse(search.error).data,
	}),
	component: function LinkScreen() {
		return <LinkPage error={linkRoute.useSearch().error} />;
	},
});

/** Settings opens this in a new tab to start a link (docs/archive/epics/EPIC-13-1.md, "The flow" step 2). */
const linkStartRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/link/start",
	component: LinkStartPage,
});

function safeUuid(value: unknown): string | undefined {
	return typeof value === "string" && UUID.test(value) ? value : undefined;
}

/**
 * `tab` names the admin tab so it can be linked; `workspace`, `user` and
 * `action` are the Audit tab's filters (SPEC.md §24.11). The Logs tab
 * shares `workspace` and `user` and adds `level`, `service`, `since`,
 * `until` and `q` (docs/EPIC-19.md ruling 32).
 */
const adminRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/admin",
	validateSearch: (search: Record<string, unknown> & SearchSchemaInput) => ({
		tab: ADMIN_TABS.find((tab) => tab === search.tab),
		workspace: safeUuid(search.workspace),
		user: safeUuid(search.user),
		action:
			typeof search.action === "string" &&
			search.action.length > 0 &&
			search.action.length <= 100
				? search.action
				: undefined,
		...sanitizeLogSearch(search),
	}),
	component: AdminPage,
});

/** An instructor's read-only Course page (Epic 13 ruling 24). */
const courseRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/course",
	component: CourseListPage,
});

const courseMembersRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/course/$courseId",
	component: CourseMembersPage,
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
	changePasswordRoute,
	acceptableUseRoute,
	unlinkedRoute,
	linkRoute,
	linkStartRoute,
	adminRoute,
	courseRoute,
	courseMembersRoute,
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
