/**
 * What the app does when the server says the session is gone (SPEC.md
 * section 5.3). The entry point registers the handler, because this module
 * cannot import the router without an import cycle.
 */
let handler: () => void = () => {};

export function setSessionEndedHandler(next: () => void): void {
	handler = next;
}

/** The session expired or was revoked: hand over to the registered handler. */
export function sessionEnded(): void {
	handler();
}
