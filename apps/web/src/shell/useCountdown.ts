import { useEffect, useState } from "react";

export interface Countdown {
	/** Whole minutes left, rounded up, so "2 minutes" never reads as "1". */
	minutes: number;
	/** The same time as m:ss, for the status bar. */
	clock: string;
	/** Local time the workspace stops, for the notice. */
	at: string;
}

/**
 * Time left before the disconnect grace period expires (SPEC.md §6.4).
 * Returns null when there is no deadline.
 */
export function useCountdown(deadline: string | null): Countdown | null {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!deadline) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [deadline]);

	if (!deadline) return null;
	const target = Date.parse(deadline);
	if (Number.isNaN(target)) return null;
	const seconds = Math.max(0, Math.round((target - now) / 1000));
	return {
		minutes: Math.max(1, Math.ceil(seconds / 60)),
		clock: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
		at: new Date(target).toLocaleTimeString([], {
			hour: "numeric",
			minute: "2-digit",
		}),
	};
}
