import type { EffectiveGuard, GuardConfig } from "./admin.js";

/** The platform guard values as the `settings` row holds them (ADR 0032). */
export interface GuardPlatform {
	cpu_guard_threshold_percent: number;
	memory_guard_threshold_percent: number;
	guard_window_minutes: number;
	cpu_throttle_share_percent: number;
	idle_stop_minutes: number;
}

/** The values one workspace runs with: any override key wins over the platform value. */
export function effectiveGuard(
	platform: GuardPlatform,
	overrides: GuardConfig | null,
): EffectiveGuard {
	return {
		cpuThresholdPercent:
			overrides?.cpuThresholdPercent ?? platform.cpu_guard_threshold_percent,
		memoryThresholdPercent:
			overrides?.memoryThresholdPercent ?? platform.memory_guard_threshold_percent,
		windowMinutes: overrides?.windowMinutes ?? platform.guard_window_minutes,
		throttleSharePercent:
			overrides?.throttleSharePercent ?? platform.cpu_throttle_share_percent,
		idleStopMinutes: overrides?.idleStopMinutes ?? platform.idle_stop_minutes,
	};
}

/** The idle-lift values as the `settings` row holds them (#596). */
export interface IdleLiftPlatform {
	cpu_idle_lift_minutes: number;
	cpu_idle_lift_percent: number;
}

/** When a throttle lifts on its own, or null when lifting is off (percent 0). */
export function idleLift(
	platform: IdleLiftPlatform,
): { minutes: number; percent: number } | null {
	if (platform.cpu_idle_lift_percent === 0) return null;
	return {
		minutes: platform.cpu_idle_lift_minutes,
		percent: platform.cpu_idle_lift_percent,
	};
}

/** The throttle-hold values as the `settings` row holds them (SPEC.md §19.4). */
export interface ThrottleHoldPlatform {
	cpu_throttle_hold_after: number;
	cpu_throttle_hold_hours: number;
}

/**
 * Record a throttle at `at`: the recent throttle times trimmed to the hold
 * window with `at` added, and why it is held when it is the Nth within the
 * window, or null when it is not or holding is off (after 0).
 */
export function throttleHold(
	platform: ThrottleHoldPlatform,
	recent: Date[],
	at: Date,
): { recent: Date[]; held: { count: number; hours: number } | null } {
	const hours = platform.cpu_throttle_hold_hours;
	const since = at.getTime() - hours * 3_600_000;
	const kept = [...recent.filter((t) => t.getTime() > since), at];
	const after = platform.cpu_throttle_hold_after;
	const held = after > 0 && kept.length >= after ? { count: kept.length, hours } : null;
	return { recent: kept, held };
}

/** The time slice for `share` percent of `cpuLimit` CPUs, never a percentage (ADR 0032). */
export function allowanceFor(sharePercent: number, cpuLimit: number): string {
	const ms = Math.max(1, Math.round((sharePercent / 100) * cpuLimit * 100));
	return `${ms}ms/100ms`;
}

/**
 * The number of CPUs an Incus `limits.cpu` value gives: a count such as "4"
 * or a CPU set such as "0-3" or "0,2,5-6". Null when unset or unreadable.
 */
export function countIncusCpus(value: unknown): number | null {
	if (typeof value !== "string" || value.trim() === "") return null;
	const text = value.trim();
	if (/^\d+$/.test(text)) {
		const n = Number(text);
		return n > 0 ? n : null;
	}
	let count = 0;
	for (const part of text.split(",")) {
		const range = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
		if (!range) return null;
		const first = Number(range[1]);
		const last = range[2] === undefined ? first : Number(range[2]);
		if (last < first) return null;
		count += last - first + 1;
	}
	return count;
}

/** The cap on one workspace's "keep running until" hold: its override wins (#955). */
export function keepRunningMaxHours(
	platformHours: number,
	overrides: GuardConfig | null,
): number {
	return overrides?.keepRunningMaxHours ?? platformHours;
}

/**
 * Why a "keep running until" time is refused, or null when it is allowed
 * (#955): it must be ahead of now and at most `maxHours` from now. A cap of 0
 * refuses every hold.
 */
export function keepRunningRefusal(
	until: Date,
	now: Date,
	maxHours: number,
): "off" | "past" | "too-far" | null {
	if (maxHours === 0) return "off";
	if (until.getTime() <= now.getTime()) return "past";
	if (until.getTime() > now.getTime() + maxHours * 3_600_000) return "too-far";
	return null;
}
