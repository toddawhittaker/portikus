import type { Project } from "@portikus/contracts";
import { Button, useToast } from "@portikus/ui";
import { useNavigate } from "@tanstack/react-router";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import { useEditorSettings } from "../editor/settingsQueries.js";
import { notifyAgentAlert, PermissionOffer } from "../notifications/desktopNotify.js";
import {
	desktopPermission,
	desktopSupported,
} from "../notifications/desktopSupport.js";
import type { CodingAgentsHandler } from "../useWorkspaceSocket.js";
import {
	type AgentAlert,
	type AgentStatusStore,
	alertTitle,
} from "./codingAgentStatus.js";

/**
 * Returns the handler for each `coding-agents` list: it feeds the list to the
 * store, and for every alert it raises shows a toast and asks for a desktop
 * notification. Agent toasts stay out of the notification history and stay on screen until
 * the terminal is viewed or the toast is dismissed (SPEC.md §8.5).
 */
export function useCodingAgentAlerts(
	store: AgentStatusStore,
	workspaceId: string,
	currentProjectId: string | undefined,
	projects: readonly Project[] | undefined,
	work: RefObject<HTMLElement | null>,
): CodingAgentsHandler {
	const toast = useToast();
	const asking = useEditorSettings().data?.agentNotifications === "ask";
	const navigate = useNavigate();
	// Read from the latest render, so a new project list never re-sends a list.
	const latest = useRef({ currentProjectId, projects, toast, navigate, asking });
	latest.current = { currentProjectId, projects, toast, navigate, asking };
	const shown = useRef(new Map<string, () => void>());
	// The offer is made once per page load, and counts as made only when it is
	// answered or dismissed, so a newer toast that replaces it carries it on.
	const offered = useRef(false);
	// The terminal whose toast carries the offer now, so two toasts never both do.
	const offerOn = useRef<string | null>(null);

	const removeToast = useCallback((terminalId: string) => {
		shown.current.get(terminalId)?.();
		shown.current.delete(terminalId);
		if (offerOn.current === terminalId) offerOn.current = null;
	}, []);

	useEffect(
		() =>
			store.onSeen((ids) => {
				for (const id of ids) removeToast(id);
			}),
		[store, removeToast],
	);

	return useCallback(
		(terminals, initial) => {
			for (const alert of store.update(terminals, initial)) raise(alert);
			// A closed terminal can never be viewed, so its toast would stay for good.
			const listed = new Set(terminals.map((terminal) => terminal.terminalId));
			for (const id of [...shown.current.keys()]) {
				if (!listed.has(id)) removeToast(id);
			}

			// Focus follows the student's choice into the work area, not back to the page.
			async function openProject(projectId: string) {
				await latest.current.navigate({
					to: "/workspaces/$id/projects/$projectId",
					params: { id: workspaceId, projectId },
				});
				work.current?.focus();
			}

			function afterOffer() {
				const tab = work.current?.querySelector<HTMLElement>(
					'[role="tab"][aria-selected="true"]',
				);
				(tab ?? work.current)?.focus();
			}

			function raise(alert: AgentAlert) {
				const { currentProjectId, projects, toast, asking } = latest.current;
				// A newer alert for the same terminal replaces the older toast.
				removeToast(alert.terminalId);
				const elsewhere = alert.projectId !== currentProjectId;
				const offer =
					!offered.current &&
					offerOn.current === null &&
					asking &&
					desktopSupported() &&
					desktopPermission() !== "denied";
				if (offer) offerOn.current = alert.terminalId;
				const name = projects?.find((project) => project.id === alert.projectId)?.name;
				const remove = toast.show({
					title: alertTitle(alert.agent, alert.state),
					children: elsewhere && name ? `In ${name}` : undefined,
					unrecorded: true,
					persistent: true,
					onDismiss: offer
						? () => {
								offered.current = true;
								if (offerOn.current === alert.terminalId) offerOn.current = null;
							}
						: undefined,
					actions:
						elsewhere || offer ? (
							<>
								{elsewhere ? (
									<Button
										size="sm"
										onClick={() => {
											removeToast(alert.terminalId);
											void openProject(alert.projectId);
										}}
									>
										Open project
									</Button>
								) : null}
								{offer ? (
									<PermissionOffer
										onAnswered={() => {
											offered.current = true;
											removeToast(alert.terminalId);
											afterOffer();
										}}
									/>
								) : null}
							</>
						) : undefined,
				});
				shown.current.set(alert.terminalId, remove);
				notifyAgentAlert(alert, () => void openProject(alert.projectId));
			}
		},
		[store, workspaceId, work, removeToast],
	);
}
