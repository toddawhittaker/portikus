/** The browser's Notification API, kept apart so tests can swap it (SPEC.md section 25.8). */

export function desktopSupported(): boolean {
	return typeof Notification !== "undefined";
}

export function desktopPermission(): NotificationPermission {
	return desktopSupported() ? Notification.permission : "denied";
}

/**
 * Asks the browser for permission. Call it only from a click: browsers
 * ignore or penalise a prompt that nobody asked for. The answer is the
 * setting to save, since a refusal means desktop notifications stay off.
 */
export async function askDesktopPermission(): Promise<"on" | "off"> {
	if (!desktopSupported()) return "off";
	try {
		return (await Notification.requestPermission()) === "granted" ? "on" : "off";
	} catch {
		return "off";
	}
}
