/** One structured JSON line per event; Fastify's own logger is off. */
export function log(
	level: "error" | "warn" | "info",
	fields: Record<string, unknown>,
): void {
	const line = JSON.stringify({ level, time: new Date().toISOString(), ...fields });
	if (level === "error") {
		console.error(line);
	} else {
		console.log(line);
	}
}
