import { errorMessage, type Logger } from "@portikus/observability";

/**
 * Run `task` now and then every `intervalMs` on its own timer, so a slow task
 * in one loop never delays another (ADR 0006, ADR 0020). A tick that lands
 * while the previous run is still busy is skipped, so runs never overlap. An
 * error the task lets escape is logged under `name`.
 *
 * The timer is unref'd, so Node's default signal handling stops the worker
 * at once on systemd's SIGTERM. Returns a function that stops the loop.
 */
export function startLoop(
	name: string,
	logger: Logger,
	task: () => Promise<void>,
	intervalMs: number,
): () => void {
	let busy = false;
	const run = async (): Promise<void> => {
		if (busy) return;
		busy = true;
		try {
			await task();
		} catch (e) {
			logger.error({ error: errorMessage(e) }, `${name} loop error`);
		} finally {
			busy = false;
		}
	};
	const timer = setInterval(() => void run(), intervalMs);
	timer.unref();
	void run();
	return () => clearInterval(timer);
}

/**
 * Run a sweep now, then again `intervalMs` after each run finishes, so runs
 * never overlap (ADR 0006, ADR 0020). The timer keeps the process alive.
 * `task` must catch its own errors. Returns a function that stops the loop.
 */
export function startSweepLoop(
	task: () => Promise<void>,
	intervalMs: number,
): () => void {
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	const run = async (): Promise<void> => {
		await task();
		if (!stopped) timer = setTimeout(run, intervalMs);
	};
	void run();
	return () => {
		stopped = true;
		clearTimeout(timer);
	};
}
