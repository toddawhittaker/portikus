import { CloseCode } from "@portikus/contracts";

type EndSocket = (code: number, reason: string) => void;

/**
 * The open helper sockets of each live help session, so an end or a typing
 * change closes them at once instead of at the next per-second check
 * (ADR 0063). Per API process, like the socket counts (ADR 0010).
 */
export interface LiveHelpRegistry {
	/** Track one helper socket; the returned function forgets it. */
	add: (sessionId: string, end: EndSocket) => () => void;
	/** Close every helper socket of a session that ended. */
	end: (sessionId: string) => void;
	/** Close every helper socket so it reconnects in the new mode. */
	modeChanged: (sessionId: string) => void;
	/** Helper sockets open on a session now. */
	open: (sessionId: string) => number;
}

export function createLiveHelpRegistry(): LiveHelpRegistry {
	const sockets = new Map<string, Set<EndSocket>>();

	function closeAll(sessionId: string, code: number, reason: string): void {
		const ends = sockets.get(sessionId);
		if (!ends) return;
		sockets.delete(sessionId);
		for (const end of ends) end(code, reason);
	}

	return {
		add(sessionId, end) {
			const ends = sockets.get(sessionId) ?? new Set<EndSocket>();
			ends.add(end);
			sockets.set(sessionId, ends);
			return () => {
				ends.delete(end);
				if (ends.size === 0 && sockets.get(sessionId) === ends) {
					sockets.delete(sessionId);
				}
			};
		},
		end(sessionId) {
			closeAll(sessionId, CloseCode.LIVE_HELP_ENDED, "live help ended");
		},
		modeChanged(sessionId) {
			closeAll(sessionId, CloseCode.LIVE_HELP_MODE_CHANGED, "live help mode changed");
		},
		open(sessionId) {
			return sockets.get(sessionId)?.size ?? 0;
		},
	};
}

/** The API process's one registry. */
export const liveHelpSockets = createLiveHelpRegistry();
