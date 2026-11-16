import { notifyAdministrators } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import { type PriceRunDeps, startPriceRun } from "./run.js";

export const WEEK_MS = 7 * 24 * 60 * 60_000;
const TICK_MS = 60 * 60_000;

/** Whether the weekly check is due: never run, or the last start is over a week old. */
export function weeklyDue(lastStartedAt: Date | null, now: Date): boolean {
	return lastStartedAt === null || now.getTime() - lastStartedAt.getTime() > WEEK_MS;
}

/**
 * One tick of the weekly price check (SPEC.md section 20.4). Runs only when
 * the built-in AI is available; tells administrators once when the run
 * proposes changes. Resolves when the run, if any, is stored.
 */
export async function weeklyPriceTick(
	deps: PriceRunDeps,
	now: Date = new Date(),
): Promise<"not-due" | "unavailable" | "running" | "ran"> {
	const last = await deps.db
		.selectFrom("price_runs")
		.select("started_at")
		.orderBy("started_at", "desc")
		.limit(1)
		.executeTakeFirst();
	if (!weeklyDue(last?.started_at ?? null, now)) return "not-due";
	const started = await startPriceRun(deps, "weekly", null);
	if ("refused" in started) return started.refused;
	const outcome = await started.done;
	if (outcome.proposals > 0) {
		await notifyAdministrators(deps.db, {
			tone: "neutral",
			title: "New model prices to review",
			body: `The weekly price check found ${outcome.proposals} changed price row(s). Review them at /admin/pricing.`,
		});
	}
	return "ran";
}

/** The hourly timer for the weekly check; returns the stop function. */
export function startWeeklyPriceTimer(deps: PriceRunDeps, logger: Logger): () => void {
	let busy = false;
	const timer = setInterval(() => {
		if (busy) return;
		busy = true;
		weeklyPriceTick(deps)
			.catch((error: unknown) =>
				logger.error({ error: errorMessage(error) }, "weekly price check error"),
			)
			.finally(() => {
				busy = false;
			});
	}, TICK_MS);
	timer.unref();
	return () => clearInterval(timer);
}
