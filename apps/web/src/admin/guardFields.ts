/**
 * The guard fields the per-workspace dialog and the Settings tab share
 * (SPEC.md §19.4). Its own module, so neither imports the other for them.
 */
import {
	type EffectiveGuard,
	GuardThresholdPercent,
	GuardWindowMinutes,
	IdleStopMinutes,
	ThrottleSharePercent,
} from "@portikus/contracts";
import type { z } from "zod";

export type GuardKey = keyof EffectiveGuard;

/** The five guard values, their labels, ranges and what a bad entry is told. */
export const GUARD_FIELDS: {
	key: GuardKey;
	label: string;
	schema: z.ZodType<number>;
	rangeText: string;
}[] = [
	{
		key: "cpuThresholdPercent",
		label: "CPU threshold (%)",
		schema: GuardThresholdPercent,
		rangeText: "Enter a whole number from 1 to 100.",
	},
	{
		key: "memoryThresholdPercent",
		label: "Memory threshold (%)",
		schema: GuardThresholdPercent,
		rangeText: "Enter a whole number from 1 to 100.",
	},
	{
		key: "windowMinutes",
		label: "Window (minutes)",
		schema: GuardWindowMinutes,
		rangeText: "Enter a whole number from 5 to 240.",
	},
	{
		key: "throttleSharePercent",
		label: "Throttled share (%)",
		schema: ThrottleSharePercent,
		rangeText: "Enter a whole number from 5 to 100.",
	},
	{
		key: "idleStopMinutes",
		label: "Idle stop (minutes)",
		schema: IdleStopMinutes,
		rangeText: "Enter 0 for never, or a whole number from 10 to 1440.",
	},
];

/** Reads one guard field, or null when the entry is not allowed. */
export function parseGuardValue(key: GuardKey, text: string): number | null {
	const field = GUARD_FIELDS.find((item) => item.key === key);
	const trimmed = text.trim();
	if (!field || !/^\d+$/.test(trimmed)) return null;
	const parsed = field.schema.safeParse(Number(trimmed));
	return parsed.success ? parsed.data : null;
}
