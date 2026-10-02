/**
 * Run `task` now and then every `intervalMs` on its own timer, so a slow task
 * in one loop never delays another (ADR 0006, ADR 0020). `task` must catch
 * its own errors and skip a run while its previous one is still busy.
 *
 * The timer is unref'd, so Node's default signal handling stops the worker
 * at once on systemd's SIGTERM. Returns a function that stops the loop.
 */
export function startLoop(task: () => Promise<void>, intervalMs: number): () => void {
	const timer = setInterval(() => void task(), intervalMs);
	timer.unref();
	void task();
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
