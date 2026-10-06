/**
 * One announcement for shells lost together. A restart closes every root
 * shell within moments, including those in hidden tabs, and a status region
 * per pane would either stay silent while hidden or say the same thing once
 * per pane (SPEC.md §25.8).
 */
import { useEffect, useRef, useState } from "react";
import { lossSummary } from "./lossText.js";
import type { RootShellLoss } from "./rootShellSocket.js";

/** How long losses gather before they are announced as one. */
const LOSS_GATHER_MS = 300;

export function useLossAnnouncement(): {
	announcement: string;
	report: (reason: RootShellLoss) => void;
} {
	const [announcement, setAnnouncement] = useState("");
	const counts = useRef(new Map<RootShellLoss, number>());
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => () => clearTimeout(timer.current), []);

	function report(reason: RootShellLoss) {
		counts.current.set(reason, (counts.current.get(reason) ?? 0) + 1);
		if (timer.current !== undefined) return;
		// Cleared first, so the same words as last time are read again.
		setAnnouncement("");
		timer.current = setTimeout(() => {
			timer.current = undefined;
			const text = [...counts.current]
				.map(([lossReason, count]) => lossSummary(lossReason, count))
				.join(" ");
			counts.current.clear();
			setAnnouncement(text);
		}, LOSS_GATHER_MS);
	}

	return { announcement, report };
}
