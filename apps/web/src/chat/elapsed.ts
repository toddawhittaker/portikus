/** A turn's length as "3m 43s", or "1h 5m" past an hour. */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${seconds}s`;
}

/** The same length as an ISO 8601 duration, for `<time dateTime>`. */
export function isoDuration(ms: number): string {
	return `PT${Math.max(0, Math.floor(ms / 1000))}S`;
}
