import { CloseCode } from "@portikus/contracts";

type EndSocket = (code: number, reason: string) => void;

/**
 * The open helper sockets of each live help session, one per terminal, so an
 * end or a typing change closes them at once instead of at the next
 * per-second check (ADR 0063). Per API process, like the socket counts
 * (ADR 0010).
 */
export interface LiveHelpRegistry {
	/**
	 * Track the helper's socket on one terminal; the returned function forgets
	 * it. The newest wins: an older socket on the same terminal is closed
	 * first, so a stale tab never locks the helper out and no keystroke is
	 * sent twice.
	 */
	add: (sessionId: string, terminalId: string, end: EndSocket) => () => void;
	/** Whether the helper has a socket on this terminal. */
	has: (sessionId: string, terminalId: string) => boolean;
	/** Close every helper socket of a session that ended. */
	end: (sessionId: string) => void;
	/** Close every helper socket so it reconnects in the new mode. */
	modeChanged: (sessionId: string) => void;
}

export function createLiveHelpRegistry(): LiveHelpRegistry {
	const sockets = new Map<string, Map<string, EndSocket>>();

	function closeAll(sessionId: string, code: number, reason: string): void {
		const ends = sockets.get(sessionId);
		if (!ends) return;
		sockets.delete(sessionId);
		for (const end of ends.values()) end(code, reason);
	}

	return {
		add(sessionId, terminalId, end) {
			const ends = sockets.get(sessionId) ?? new Map<string, EndSocket>();
			ends.get(terminalId)?.(CloseCode.LIVE_HELP_REPLACED, "opened in another tab");
			ends.set(terminalId, end);
			sockets.set(sessionId, ends);
			return () => {
				if (ends.get(terminalId) === end) ends.delete(terminalId);
				if (ends.size === 0 && sockets.get(sessionId) === ends) {
					sockets.delete(sessionId);
				}
			};
		},
		has(sessionId, terminalId) {
			return sockets.get(sessionId)?.has(terminalId) ?? false;
		},
		end(sessionId) {
			closeAll(sessionId, CloseCode.LIVE_HELP_ENDED, "live help ended");
		},
		modeChanged(sessionId) {
			closeAll(sessionId, CloseCode.LIVE_HELP_MODE_CHANGED, "live help mode changed");
		},
	};
}

/** The API process's one registry. */
export const liveHelpSockets = createLiveHelpRegistry();
