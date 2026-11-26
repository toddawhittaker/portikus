import type { ProjectOperation } from "@portikus/contracts";
import { Button, useToast } from "@portikus/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { errorText } from "../api/request.js";
import {
	followHere,
	isOperationHandled,
	isOperationStartedHere,
	onOperationHandOff,
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

const DONE_VERB: Record<ProjectOperation["kind"], string> = {
	create: "created",
	duplicate: "duplicated",
	restore: "restored",
};

/**
 * Follows a clone, duplicate or restore the page no longer shows in a dialog:
 * one still running after a reload, one this tab started and has not shown
 * yet, or one a dialog closed on (SPEC.md §7.2, §7.3, §15.8). The outcome is
 * announced in a toast; the page stays where the student is, with an "Open
 * project" action, because switching it could interrupt their typing.
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
		const controller = new AbortController();
		const { signal } = controller;
		const following = new Set<string>();
		const dismissals = new Set<() => void>();

		async function follow(found: ProjectOperation) {
			if (following.has(found.id)) return;
			following.add(found.id);
			let dismiss: (() => void) | undefined;
			if (found.state === "running") {
				dismiss = toast.show({
					title: RUNNING_TITLE[found.kind],
					persistent: true,
					unrecorded: true,
				});
				dismissals.add(dismiss);
			}
			const settle = () => {
				if (dismiss) {
					dismiss();
					dismissals.delete(dismiss);
				}
			};
			let done: ProjectOperation;
			try {
				done = await followHere(workspaceId, found, signal);
			} catch (error) {
				settle();
				if (signal.aborted) return;
				toast.show({
					tone: "danger",
					title: FAILED_TITLE[found.kind],
					children: errorText(error),
				});
				return;
			}
			settle();
			if (signal.aborted) return;
			await client.invalidateQueries();
			const made = done.project;
			if (made) {
				toast.show({
					tone: "success",
					title: `${made.name} ${DONE_VERB[found.kind]}`,
					actions: (
						<Button
							size="sm"
							variant="secondary"
							onClick={() =>
								void navigate({
									to: "/workspaces/$id/projects/$projectId",
									params: { id: workspaceId, projectId: made.id },
								})
							}
						>
							Open project
						</Button>
					),
				});
			} else {
				toast.show({ tone: "success", title: `Project ${DONE_VERB[found.kind]}` });
			}
		}

		const stopListening = onOperationHandOff((id, operation) => {
			if (id === workspaceId) void follow(operation);
		});

		void (async () => {
			const found = await readOperation(workspaceId, signal).catch(() => null);
			if (signal.aborted || !found) return;
			// A finished operation is replayed only in the tab that started it,
			// and only once there.
			if (
				found.state !== "running" &&
				(!isOperationStartedHere(found.id) || isOperationHandled(found.id))
			)
				return;
			void follow(found);
		})();

		return () => {
			controller.abort();
			stopListening();
			for (const dismiss of dismissals) dismiss();
		};
	}, [workspaceId, running, toast, client, navigate]);

	return null;
}
