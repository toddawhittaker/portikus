/**
 * The tab that links accounts tells the tab that started it how it ended
 * (docs/EPIC-13-1.md, "The flow" steps 2 and 4). BroadcastChannel is
 * same-origin only.
 */
export const LINK_CHANNEL = "portikus-link";

export type LinkMessage = { type: "linked" } | { type: "cancelled" };

export function announceLink(message: LinkMessage) {
	const channel = new BroadcastChannel(LINK_CHANNEL);
	channel.postMessage(message);
	channel.close();
}

/** Tell the waiting tab the link was abandoned, then close this tab or, if the browser refuses, go home. */
export function leaveLinkTab() {
	announceLink({ type: "cancelled" });
	window.close();
	if (!window.closed) location.assign("/");
}
