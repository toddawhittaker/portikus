import type { ProjectOperation } from "@portikus/contracts";
import { useToast } from "@portikus/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { errorText } from "../api/request.js";
import {
	followOperation,
	isOperationHandled,
	markOperationHandled,
	readOperation,
} from "./operations.js";

const RUNNING_TITLE: Record<ProjectOperation["kind"], string> = {
	create: "Still creating your project…",
	duplicate: "Still duplicating your project…",
	restore: "Still restoring your project…",
};

const FAILED_TITLE: Record<ProjectOperation["kind"], string> = {
	create: "The project was not created",
	duplicate: "The project was not duplicated",
	restore: "The restore did not finish",
};

/**
 * After a reload, finds a clone, duplicate or restore the page started and
 * shows its progress and outcome, as the dialog would have (SPEC.md §7.2,
 * §7.3, §15.8). An outcome this tab already showed is not shown again.
 */
export function ResumeProjectOperation({
	workspaceId,
	running,
}: {
	workspaceId: string;
	running: boolean;
}) {
	const toast = useToast();
	const client = useQueryClient();
	const navigate = useNavigate();

	useEffect(() => {
		if (!running) return;
		let cancelled = false;
		let dismiss: (() => void) | undefined;

		async function resume() {
			const found = await readOperation(workspaceId).catch(() => null);
			if (cancelled || !found) return;
			if (found.state !== "running" && isOperationHandled(found.id)) return;
			if (found.state === "running") {
				dismiss = toast.show({
					title: RUNNING_TITLE[found.kind],
					persistent: true,
					unrecorded: true,
				});
			}
			let done: ProjectOperation;
			try {
				done = await followOperation(workspaceId, found);
			} catch (error) {
				dismiss?.();
				if (cancelled) return;
				markOperationHandled(found.id);
				toast.show({
					tone: "danger",
					title: FAILED_TITLE[found.kind],
					children: errorText(error),
				});
				return;
			}
			dismiss?.();
			if (cancelled) return;
			markOperationHandled(found.id);
			await client.invalidateQueries();
			if (done.project) {
				toast.show({ tone: "success", title: `${done.project.name} created` });
				void navigate({
					to: "/workspaces/$id/projects/$projectId",
					params: { id: workspaceId, projectId: done.project.id },
				});
			} else {
				toast.show({ tone: "success", title: "Restore finished" });
			}
		}

		void resume();
		return () => {
			cancelled = true;
			dismiss?.();
		};
	}, [workspaceId, running, toast, client, navigate]);

	return null;
}
