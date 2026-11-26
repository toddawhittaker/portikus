/**
 * A clone url or project slug with this marker stands in for a clone, copy
 * or restore that takes long enough for the browser to show progress and to
 * reload part way, as a slow one does behind a proxy's response timeout.
 */
const SLOW_MOTION_MARKER = "slow-motion";
const SLOW_MOTION_MS = 4000;

export async function slowMotionIfMarked(value: string | undefined): Promise<void> {
	if (!(value ?? "").includes(SLOW_MOTION_MARKER)) return;
	await new Promise((resolve) => setTimeout(resolve, SLOW_MOTION_MS));
}
