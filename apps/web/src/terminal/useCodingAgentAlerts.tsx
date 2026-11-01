import type { Project } from "@portikus/contracts";
import { Button, useToast } from "@portikus/ui";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { notifyAgentAlert, PermissionOffer } from "../notifications/desktopNotify.js";
import type { CodingAgentsUpdate } from "../useWorkspaceSocket.js";
import {
	type AgentAlert,
	type AgentStatusStore,
	alertTitle,
} from "./codingAgentStatus.js";

/**
 * Feeds each `coding-agents` list to the store, and for every alert it raises
 * shows a toast and asks for a desktop notification. Agent toasts stay out of
 * the notification history (SPEC.md §8.5).
 */
export function useCodingAgentAlerts(
	store: AgentStatusStore,
	update: CodingAgentsUpdate | null,
	workspaceId: string,
	currentProjectId: string | undefined,
	projects: readonly Project[] | undefined,
): void {
	const toast = useToast();
	const navigate = useNavigate();
	// Read from the latest render, so a new project list never re-sends a list.
	const latest = useRef({ currentProjectId, projects, toast, navigate });
	latest.current = { currentProjectId, projects, toast, navigate };
	const shown = useRef(new Map<string, () => void>());
	// Only the first agent toast on a page load carries the notification offer.
	const offered = useRef(false);

	useEffect(() => {
		const remove = shown.current;
		return store.onSeen((ids) => {
			for (const id of ids) remove.get(id)?.();
		});
	}, [store]);

	useEffect(() => {
		if (!update) return;
		for (const alert of store.update(update.terminals, update.initial)) {
			raise(alert);
		}

		function raise(alert: AgentAlert) {
			const { currentProjectId, projects, toast, navigate } = latest.current;
			// A newer alert for the same terminal replaces the older toast.
			shown.current.get(alert.terminalId)?.();
			const elsewhere = alert.projectId !== currentProjectId;
			const offer = !offered.current;
			offered.current = true;
			const name = projects?.find((project) => project.id === alert.projectId)?.name;
			const remove = toast.show({
				title: alertTitle(alert.agent, alert.state),
				children: elsewhere && name ? `In ${name}` : undefined,
				unrecorded: true,
				actions:
					elsewhere || offer ? (
						<>
							{elsewhere ? (
								<Button
									size="sm"
									onClick={() => {
										shown.current.get(alert.terminalId)?.();
										void navigate({
											to: "/workspaces/$id/projects/$projectId",
											params: { id: workspaceId, projectId: alert.projectId },
										});
									}}
								>
									Open project
								</Button>
							) : null}
							{offer ? <PermissionOffer /> : null}
						</>
					) : undefined,
			});
			shown.current.set(alert.terminalId, remove);
			notifyAgentAlert({
				agent: alert.agent,
				state: alert.state,
				workspaceId,
				projectId: alert.projectId,
				terminalId: alert.terminalId,
			});
		}
	}, [update, store, workspaceId]);
}
