/**
 * Run `task` now and then every `intervalMs` on its own timer, so a slow task
 * in one loop never delays another (ADR 0006, ADR 0020). `task` must catch
 * its own errors and skip a run while its previous one is still busy.
 *
 * By default the timer is unref'd, so Node's default signal handling stops
 * the worker at once on systemd's SIGTERM. With `afterRun`, the next run is
 * scheduled `intervalMs` after the previous one finishes and the timer keeps
 * the process alive (the reconcile and recovery sweeps).
 *
 * Returns a function that stops the loop.
 */
export function startLoop(
	task: () => Promise<void>,
	intervalMs: number,
	options: { afterRun?: boolean } = {},
): () => void {
	if (options.afterRun) {
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
	const timer = setInterval(() => void task(), intervalMs);
	timer.unref();
	void task();
	return () => clearInterval(timer);
}
