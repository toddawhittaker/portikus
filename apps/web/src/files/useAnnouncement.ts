import { useCallback, useEffect, useRef, useState } from "react";

/** How long the live region stays empty before the new words go in. */
export const ANNOUNCE_GAP_MS = 50;

/**
 * The words for a polite live region (SPEC.md section 25.8). Each call empties
 * the region first and puts the words in a moment later, so the same words
 * twice in a row change the region and are spoken again.
 */
export function useAnnouncement(): [string, (text: string) => void] {
	const [text, setText] = useState("");
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const announce = useCallback((next: string) => {
		clearTimeout(timer.current);
		setText("");
		timer.current = setTimeout(() => setText(next), ANNOUNCE_GAP_MS);
	}, []);
	return [text, announce];
}
