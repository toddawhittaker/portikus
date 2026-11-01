import { MeSettings } from "@portikus/contracts";
import { request } from "../api/request.js";
import { desktopPermission, desktopSupported } from "./desktopSupport.js";

export { PermissionOffer } from "./PermissionOffer.js";

export interface AgentAlert {
	agent: "claude" | "codex";
	state: "needs-input" | "finished";
	workspaceId: string;
	projectId: string;
	terminalId: string;
}

const AGENT_NAME = { claude: "Claude Code", codex: "Codex" } as const;
const STATE_TEXT = { "needs-input": "needs your input", finished: "finished" } as const;

/**
 * Shows an operating-system notification for an agent alert, only when the
 * student turned them on, the browser allows them, and the page is not the
 * one being looked at. The text names the agent and the state and nothing
 * else, because lab computers are shared (SPEC.md section 25.8).
 */
export function notifyAgentAlert(alert: AgentAlert): void {
	if (!desktopSupported() || desktopPermission() !== "granted") return;
	if (!document.hidden && document.hasFocus()) return;
	// Read when an alert arrives, so a change made in another tab is honoured.
	void request(MeSettings, "/me/settings").then(
		(settings) => {
			if (settings.agentNotifications === "on") show(alert);
		},
		() => {},
	);
}

function show({ agent, state, workspaceId, projectId, terminalId }: AgentAlert): void {
	const note = new Notification("Portikus", {
		body: `${AGENT_NAME[agent]} ${STATE_TEXT[state]}`,
		tag: terminalId,
	});
	note.onclick = () => {
		window.focus();
		note.close();
		// Loaded on click: the router imports the pages that import this file.
		void import("../router.js").then(({ router }) =>
			router.navigate({
				to: "/workspaces/$id/projects/$projectId",
				params: { id: workspaceId, projectId },
			}),
		);
	};
}
