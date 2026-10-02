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
} as const;
