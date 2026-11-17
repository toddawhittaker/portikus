/**
 * The most recent Monday at 08:00 in the server's local time that is not
 * after `now`. A digest is due when none was sent since then, so a restart
 * neither skips a week nor sends one twice (SPEC.md section 20.4).
 */
export function latestMondayEight(now: Date): Date {
	const at = new Date(now);
	at.setHours(8, 0, 0, 0);
	at.setDate(at.getDate() - ((at.getDay() + 6) % 7));
	if (at.getTime() > now.getTime()) at.setDate(at.getDate() - 7);
	return at;
}

/** Whether this week's digest has not been sent: never sent, or last sent before this Monday 08:00. */
export function digestDue(lastSentAt: Date | null, now: Date): boolean {
	return lastSentAt === null || lastSentAt.getTime() < latestMondayEight(now).getTime();
}
