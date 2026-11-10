import type { Query, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import {
	type ClaudeLimitWindows,
	limitsFromUsage,
	mergeRateLimits,
} from "./claude-adapter.js";

/** A plan-usage request slower than this is given up; the last figure stays. */
const PLAN_USAGE_TIMEOUT_MS = 10_000;

/**
 * The plan's limit windows for one chat tab, posted to the loopback
 * receiver as they change (SPEC.md §10.8). One usage request runs at a
 * time and a slow one is given up, so an older answer can never land after
 * a newer one.
 */
export class PlanUsage {
	private limits: ClaudeLimitWindows = {};
	private inFlight = false;

	constructor(
		private readonly post: (windows: ClaudeLimitWindows) => Promise<void>,
		private readonly timeoutMs = PLAN_USAGE_TIMEOUT_MS,
	) {}

	/** A `rate_limit_event` from the session. */
	rateLimit(info: SDKRateLimitInfo): void {
		this.limits = mergeRateLimits(this.limits, info);
		void this.post(this.limits).catch(() => undefined);
	}

	/**
	 * Claude Code's `rate_limit_event` often carries no figure, so the
	 * seven-day usage is asked for directly. A failure keeps the last figure.
	 */
	async refresh(session: Query, stillCurrent: () => boolean): Promise<void> {
		if (this.inFlight) return;
		this.inFlight = true;
		let timer: NodeJS.Timeout | undefined;
		try {
			const usage = await Promise.race([
				session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
					skipBehaviors: true,
				}),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("timed out")), this.timeoutMs);
				}),
			]);
			const found = limitsFromUsage(usage);
			if (!stillCurrent() || !found.seven_day) return;
			this.limits = { ...this.limits, ...found };
			await this.post(this.limits);
		} catch {
			// The last known figure stays.
		} finally {
			clearTimeout(timer);
			this.inFlight = false;
		}
	}
}
