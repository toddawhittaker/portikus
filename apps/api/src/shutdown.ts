/** Longest wait for a clean close before exiting anyway. */
export const SHUTDOWN_GRACE_MS = 5_000;

interface Closable {
	close(): Promise<unknown>;
}

interface SignalSource {
	once(signal: "SIGTERM", listener: () => void): unknown;
	exit(code: number): void;
}

/**
 * On systemd's SIGTERM, close the server so its onClose hooks run (the
 * request-metrics flush, the log-level sync, the Dex client), then exit.
 */
export function closeOnSigterm(app: Closable, proc: SignalSource = process): void {
	proc.once("SIGTERM", () => {
		setTimeout(() => proc.exit(0), SHUTDOWN_GRACE_MS).unref();
		void app.close().then(
			() => proc.exit(0),
			() => proc.exit(1),
		);
	});
}
