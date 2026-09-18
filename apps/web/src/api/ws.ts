/**
 * The WebSocket URL of an API path. The scheme follows the page's, so a
 * development server on http and the pilot on https both work.
 */
export function wsUrl(path: string): string {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${location.host}${path}`;
}
