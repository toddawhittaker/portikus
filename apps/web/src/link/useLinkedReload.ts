import { useEffect } from "react";
import { LINK_CHANNEL, type LinkMessage } from "./channel.js";

/**
 * Any Portikus tab reloads when a link finishes in another tab, even with
 * Settings closed (docs/archive/epics/EPIC-13-1.md, "The flow" step 4). Confirming ended
 * the course session; the shared cookie now holds the SSO one.
 */
export function useLinkedReload() {
	useEffect(() => {
		const channel = new BroadcastChannel(LINK_CHANNEL);
		channel.onmessage = (event: MessageEvent<LinkMessage>) => {
			// The link tab hears its own page's message through this second channel; it stays put.
			if (location.pathname.startsWith("/link")) return;
			if (event.data?.type === "linked") location.assign("/");
		};
		return () => channel.close();
	}, []);
}
