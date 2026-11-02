import { MeSettings } from "@portikus/contracts";
import { request } from "../api/request.js";
import { type AgentAlert, alertTitle } from "../terminal/codingAgentStatus.js";
import { desktopPermission, desktopSupported } from "./desktopSupport.js";

export { PermissionOffer } from "./PermissionOffer.js";

/**
 * Shows an operating-system notification for an agent alert, only when the
 * student turned them on, the browser allows them, and the page is not the
 * one being looked at. The text names the agent and the state and nothing
 * else, because lab computers are shared (SPEC.md section 25.8). Clicking it
 * focuses the window and calls `onOpen`.
 */
export function notifyAgentAlert(alert: AgentAlert, onOpen: () => void): void {
	if (!desktopSupported() || desktopPermission() !== "granted") return;
	if (!document.hidden && document.hasFocus()) return;
	// Read when an alert arrives, so a change made in another tab is honoured.
	void request(MeSettings, "/me/settings").then(
		(settings) => {
			if (settings.agentNotifications === "on") show(alert, onOpen);
		},
		() => {},
	);
}

function show({ agent, state, terminalId }: AgentAlert, onOpen: () => void): void {
	const note = new Notification("Portikus", {
		body: alertTitle(agent, state),
		tag: terminalId,
	});
	note.onclick = () => {
		window.focus();
		note.close();
		onOpen();
	};
}
