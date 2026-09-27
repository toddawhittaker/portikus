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
