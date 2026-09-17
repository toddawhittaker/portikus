import {
	type CreateProjectRequest,
	Project,
	ProjectList,
	type ProjectState,
	ProjectTemplateList,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "../api/request.js";

const base = (workspaceId: string) => `/workspaces/${workspaceId}/projects`;

export const projectKeys = {
	list: (workspaceId: string, state: ProjectState) =>
		["projects", workspaceId, state] as const,
	templates: (workspaceId: string) => ["project-templates", workspaceId] as const,
};

/** The active or archived projects of one workspace (SPEC.md §7.4). */
export function useProjects(workspaceId: string, state: ProjectState = "active") {
	return useQuery({
		queryKey: projectKeys.list(workspaceId, state),
		queryFn: async () =>
			(await request(ProjectList, `${base(workspaceId)}?state=${state}`)).projects,
	});
}

/** The templates an administrator configured; empty hides the option. */
export function useProjectTemplates(workspaceId: string) {
	return useQuery({
		queryKey: projectKeys.templates(workspaceId),
		staleTime: Number.POSITIVE_INFINITY,
		queryFn: async () =>
			(await request(ProjectTemplateList, `${base(workspaceId)}/templates`)).templates,
	});
}

/** Both lists change after almost every operation, so both are refetched. */
function useInvalidateProjects(workspaceId: string) {
	const client = useQueryClient();
	return () => {
		void client.invalidateQueries({ queryKey: ["projects", workspaceId] });
	};
}

function json(method: string, body: unknown): RequestInit {
	return {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}

export function useCreateProject(workspaceId: string) {
	const invalidate = useInvalidateProjects(workspaceId);
	return useMutation({
		mutationFn: (body: CreateProjectRequest) =>
			request(Project, base(workspaceId), json("POST", body)),
		onSuccess: invalidate,
	});
}

export function useRenameProject(workspaceId: string) {
	const invalidate = useInvalidateProjects(workspaceId);
	return useMutation({
		mutationFn: ({ projectId, name }: { projectId: string; name: string }) =>
			request(Project, `${base(workspaceId)}/${projectId}`, json("PATCH", { name })),
		onSuccess: invalidate,
	});
}

export function useDuplicateProject(workspaceId: string) {
	const invalidate = useInvalidateProjects(workspaceId);
	return useMutation({
		mutationFn: ({ projectId, name }: { projectId: string; name: string }) =>
			request(
				Project,
				`${base(workspaceId)}/${projectId}/duplicate`,
				json("POST", { name }),
			),
		onSuccess: invalidate,
	});
}

export function useGitInitProject(workspaceId: string) {
	const invalidate = useInvalidateProjects(workspaceId);
	return useMutation({
		mutationFn: (projectId: string) =>
			request(Project, `${base(workspaceId)}/${projectId}/git-init`, {
				method: "POST",
			}),
		onSuccess: invalidate,
	});
}

export function useArchiveProject(workspaceId: string) {
	const invalidate = useInvalidateProjects(workspaceId);
	return useMutation({
		mutationFn: (projectId: string) =>
			request(
				Project,
				`${base(workspaceId)}/${projectId}`,
				json("PATCH", { state: "archived" }),
			),
		onSuccess: invalidate,
	});
}

export function useUnarchiveProject(workspaceId: string) {
	const invalidate = useInvalidateProjects(workspaceId);
	return useMutation({
		mutationFn: (projectId: string) =>
			request(
				Project,
				`${base(workspaceId)}/${projectId}`,
				json("PATCH", { state: "active" }),
			),
		onSuccess: invalidate,
	});
}

/**
 * Download is a plain navigation so the browser saves the zip itself; the
 * session cookie rides along and no blob is held in memory.
 */
export function downloadProject(workspaceId: string, projectId: string): void {
	window.location.assign(`${base(workspaceId)}/${projectId}/download`);
}
