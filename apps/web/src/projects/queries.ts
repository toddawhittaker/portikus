import {
	type CreateProjectRequest,
	Project,
	ProjectList,
	type ProjectState,
	ProjectTemplateList,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { request } from "../api/request.js";

const base = (workspaceId: string) => `/workspaces/${workspaceId}/projects`;

export const projectKeys = {
	list: (workspaceId: string, state: ProjectState) =>
		["projects", workspaceId, state] as const,
	templates: (workspaceId: string) => ["project-templates", workspaceId] as const,
};

/**
 * The active or archived projects of one workspace (SPEC.md §7.4). Polled so a
 * directory made in a terminal is discovered without any UI action (§7.6);
 * React Query pauses the polling while the tab is hidden.
 */
export function useProjects(workspaceId: string, state: ProjectState = "active") {
	return useQuery({
		queryKey: projectKeys.list(workspaceId, state),
		refetchInterval: 10_000,
		refetchOnWindowFocus: true,
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

/** Deleting answers 204, so nothing comes back to parse. */
export function useDeleteProject(workspaceId: string) {
	const invalidate = useInvalidateProjects(workspaceId);
	return useMutation({
		mutationFn: ({ projectId, slug }: { projectId: string; slug: string }) =>
			request(
				z.undefined(),
				`${base(workspaceId)}/${projectId}`,
				json("DELETE", { slug }),
			),
		onSuccess: invalidate,
	});
}

/**
 * The URL of a project's zip. The menu links to it with a download
 * attribute, so the browser streams the file to disk itself. The gateway
 * exempts this path from the single-page app routing.
 */
export function projectDownloadUrl(workspaceId: string, projectId: string): string {
	return `${base(workspaceId)}/${projectId}/download`;
}
