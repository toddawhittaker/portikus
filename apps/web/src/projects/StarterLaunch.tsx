import { StarterProjectResponse } from "@portikus/contracts";
import { useToast } from "@portikus/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { ApiError } from "../api/request.js";
import { followHere, sendOperation } from "./operations.js";

export const STARTER_CREATED = "Your starter project is ready";
export const STARTER_OPENED = "Opened your existing project";
export const STARTER_ARCHIVED =
	"You archived this project; restore it from Archived projects";
export const STARTER_PREPARING = "Setting up your starter project…";
export const STARTER_EXPIRED =
	"This starter link has expired. Open the link from your course again.";

/**
 * Turns a course launch (`/?starter=<id>`) into a project once the workspace
 * is running, then opens it (SPEC.md §7.2). Renders nothing.
 */
export function StarterLaunch({
	workspaceId,
	starterId,
	running,
}: {
	workspaceId: string;
	starterId: string | undefined;
	running: boolean;
}) {
	const toast = useToast();
	const navigate = useNavigate();
	const client = useQueryClient();
	// A starter id is single-use on the server, so a re-render or a strict-mode
	// replay must never send it twice.
	const started = useRef<string | null>(null);
	const { mutateAsync } = useMutation({
		mutationFn: async (id: string): Promise<StarterProjectResponse> => {
			const sent = await sendOperation(`/workspaces/${workspaceId}/projects/starter`, {
				starterId: id,
			});
			if (sent.kind === "answered") return StarterProjectResponse.parse(sent.body);
			// A clone or template copy finishes on the server; say so while it runs.
			const dismiss = toast.show({
				title: STARTER_PREPARING,
				persistent: true,
				unrecorded: true,
			});
			try {
				const done = await followHere(workspaceId, sent.operation);
				if (!done.project) throw new Error("Could not create your starter project.");
				return { project: done.project, created: true };
			} finally {
				dismiss();
			}
		},
	});

	useEffect(() => {
		if (!starterId || !running || started.current === starterId) return;
		started.current = starterId;
		const toWorkspace = () =>
			navigate({ to: "/workspaces/$id", params: { id: workspaceId }, replace: true });
		void (async () => {
			try {
				const { project, created } = await mutateAsync(starterId);
				await client.invalidateQueries({ queryKey: ["projects", workspaceId] });
				if (project.state === "archived") {
					toast.show({ tone: "warning", title: STARTER_ARCHIVED });
					await toWorkspace();
					return;
				}
				toast.show({
					tone: "success",
					title: created ? STARTER_CREATED : STARTER_OPENED,
				});
				await navigate({
					to: "/workspaces/$id/projects/$projectId",
					params: { id: workspaceId, projectId: project.id },
					replace: true,
				});
			} catch (error) {
				const expired = error instanceof ApiError && error.status === 404;
				toast.show({
					tone: expired ? "warning" : "danger",
					title: expired
						? STARTER_EXPIRED
						: error instanceof Error
							? error.message
							: "Could not create your starter project.",
				});
				await toWorkspace();
			}
		})();
	}, [starterId, running, workspaceId, mutateAsync, client, toast, navigate]);

	return null;
}
