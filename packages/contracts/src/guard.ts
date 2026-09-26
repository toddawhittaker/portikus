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
