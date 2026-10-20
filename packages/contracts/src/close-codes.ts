/**
 * WebSocket close codes the API, the workspace agent and the browser agree on
 * (SPEC.md §5.3, §11.4). 1008 and 1011 are the standard RFC 6455 codes.
 */
export const CloseCode = {
	/** A request the client should not retry as it is. */
	POLICY: 1008,
	/** A failure on the server's side. */
	SERVER_ERROR: 1011,
	/** The session expired or was revoked; the browser goes to sign-in. */
	SESSION_ENDED: 4401,
	/** The project or terminal does not exist. */
	NOT_FOUND: 4404,
	/** The student turned typing on or off; the instructor reconnects in the new mode (ADR 0063). */
	LIVE_HELP_MODE_CHANGED: 4409,
	/** The live help session ended; the instructor does not reconnect (ADR 0063). */
	LIVE_HELP_ENDED: 4410,
	/** The helper opened this terminal in another tab; this one stops and does not reconnect (ADR 0063). */
	LIVE_HELP_REPLACED: 4411,
	/** The user already has as many sockets of this kind open as allowed (SPEC.md §24.13). */
	TOO_MANY_SOCKETS: 4429,
} as const;
