import {
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
} from "@tanstack/react-router";
import { ComingLater } from "./ComingLater";
import { Home } from "./Home";
import { WorkspacePage } from "./WorkspacePage";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: Home,
});

const workspaceRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/workspaces/$id",
	component: WorkspacePage,
});

const filesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/workspaces/$id/files",
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
	path: "/workspaces/$id/preview/$port",
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

export const router = createRouter({
	routeTree: rootRoute.addChildren([
		indexRoute,
		workspaceRoute,
		filesRoute,
		previewRoute,
	]),
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
