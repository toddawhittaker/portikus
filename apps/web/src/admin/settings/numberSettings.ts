import {
	CpuIdleLiftMinutes,
	CpuIdleLiftPercent,
	CpuThrottleHoldAfter,
	CpuThrottleHoldHours,
} from "@portikus/contracts";
import type { z } from "zod";
import { graceMinutes, parseGraceMinutes } from "../graceText.js";
import { GUARD_FIELDS, type GuardKey, parseGuardValue } from "../guardFields.js";

/** The platform settings the When workspaces stop and Resource guard sections hold. */
export type NumberKey =
	| "shutdownGraceSeconds"
	| "idleStopMinutes"
	| "keepRunningMaxHours"
	| "guardWindowMinutes"
	| "cpuGuardThresholdPercent"
	| "cpuThrottleSharePercent"
	| "cpuIdleLiftMinutes"
	| "cpuIdleLiftPercent"
	| "cpuThrottleHoldAfter"
	| "cpuThrottleHoldHours"
	| "memoryGuardThresholdPercent";

export interface NumberSetting {
	label: string;
	unit: string;
	/** What it does, in one or two plain sentences (SPEC.md sections 6.4 and 19.4). */
	description: string;
	/** The default, the range, and where else it is set. */
	meta: string;
	/** What to enter instead, shown under the field. */
	error: string;
	inputMode: "numeric" | "decimal";
	/** The stored value as the box shows it. */
	toText: (value: number) => string;
	/** The box's text as the value to store, or null when it is not allowed. */
	parse: (text: string) => number | null;
}

const PER_WORKSPACE = "Also set per workspace on the Users tab.";

/** A setting the per-workspace guard dialog shares: its label, unit and range come from there. */
function shared(
	key: GuardKey,
	text: { description: string; meta: string },
): NumberSetting {
	const field = GUARD_FIELDS.find((item) => item.key === key);
	if (!field) throw new Error(`no guard field ${key}`);
	return {
		label: field.label,
		unit: field.unit,
		error: field.rangeText,
		inputMode: "numeric",
		toText: String,
		parse: (value) => parseGuardValue(key, value),
		...text,
	};
}

function whole(schema: z.ZodType<number>) {
	return (text: string): number | null => {
		const trimmed = text.trim();
		if (!/^\d+$/.test(trimmed)) return null;
		const parsed = schema.safeParse(Number(trimmed));
		return parsed.success ? parsed.data : null;
	};
}

function own(
	setting: Omit<NumberSetting, "inputMode" | "toText" | "parse">,
	schema: z.ZodType<number>,
): NumberSetting {
	return { ...setting, inputMode: "numeric", toText: String, parse: whole(schema) };
}

export const NUMBER_SETTINGS: Record<NumberKey, NumberSetting> = {
	shutdownGraceSeconds: {
		label: "Disconnect grace",
		unit: "minutes",
		description:
			"How long a workspace keeps running after the student's last browser tab closes or loses its connection, so a reload or a Wi-Fi drop comes back to a running workspace. 0 keeps it running until it is stopped by hand.",
		meta: "Default 10 minutes. Also set per student on the Users tab.",
		error: "Enter a number of minutes, 0 or more.",
		inputMode: "decimal",
		// Shown in minutes; the API keeps seconds (SPEC.md section 6.4).
		toText: graceMinutes,
		parse: parseGraceMinutes,
	},
	idleStopMinutes: shared("idleStopMinutes", {
		description:
			"With no key press, click, file save or preview visit for this long, the student is asked “Still working?” and the workspace stops five minutes later, even with a tab open. 0 turns idle stop off.",
		meta: `Default 60 minutes; 10 to 1,440. ${PER_WORKSPACE}`,
	}),
	keepRunningMaxHours: shared("keepRunningMaxHours", {
		description:
			"The longest a student can choose Keep running, for example while an agent works overnight. Neither timer applies until then. Lowering it shortens holds already set. 0 turns Keep running off.",
		meta: `Default 12 hours; up to 168. ${PER_WORKSPACE}`,
	}),
	guardWindowMinutes: shared("windowMinutes", {
		description:
			"CPU and memory use are averaged over this period before a workspace is slowed or flagged. It applies to both rules below.",
		meta: `Default 30 minutes; 5 to 240. ${PER_WORKSPACE}`,
	}),
	cpuGuardThresholdPercent: shared("cpuThresholdPercent", {
		description:
			"Average CPU use, as a share of the workspace's CPUs, that counts as heavy. 100 turns slowing off.",
		meta: `Default 80%; 1 to 100. ${PER_WORKSPACE}`,
	}),
	cpuThrottleSharePercent: shared("throttleSharePercent", {
		description: "The share of its CPUs a slowed workspace keeps. 25 means a quarter.",
		meta: `Default 25%; 5 to 100. ${PER_WORKSPACE}`,
	}),
	cpuIdleLiftMinutes: own(
		{
			label: "Quiet time",
			unit: "minutes",
			description:
				"A slowed workspace gets full speed back by itself once it stays quiet this long. Stopping and starting it also does, unless it is held.",
			meta: "Default 5 minutes; 1 to 60.",
			error: "Enter a whole number from 1 to 60.",
		},
		CpuIdleLiftMinutes,
	),
	cpuIdleLiftPercent: own(
		{
			label: "Quiet means under",
			unit: "%",
			description:
				"CPU use under this share, and under half the slowed speed, counts as quiet. 0 turns the automatic return off.",
			meta: "Default 10%; up to 100.",
			error: "Enter 0 to turn the automatic return off, or a whole number up to 100.",
		},
		CpuIdleLiftPercent,
	),
	cpuThrottleHoldAfter: own(
		{
			label: "Slowdowns before a hold",
			unit: "slowdowns",
			description:
				"After this many slowdowns within the hold period, the workspace stays slowed even through a restart. It still gets full speed back when it goes quiet or you lift it. 0 turns holds off.",
			meta: "Default 3; up to 10.",
			error: "Enter 0 to turn holds off, or a whole number up to 10.",
		},
		CpuThrottleHoldAfter,
	),
	cpuThrottleHoldHours: own(
		{
			label: "Hold period",
			unit: "hours",
			description: "The period the slowdowns are counted over.",
			meta: "Default 24 hours; 1 to 168.",
			error: "Enter a whole number from 1 to 168.",
		},
		CpuThrottleHoldHours,
	),
	memoryGuardThresholdPercent: shared("memoryThresholdPercent", {
		description:
			"Average memory use, as a share of the workspace's memory limit, that flags it on the Health and Users tabs. Nothing is slowed. 100 turns flagging off.",
		meta: `Default 90%; 1 to 100. ${PER_WORKSPACE}`,
	}),
};

/** A value with its unit: "80%", "1 hour", "45 minutes". */
export function withUnit(text: string, unit: string): string {
	if (unit === "%") return `${text}%`;
	return `${text} ${text === "1" ? unit.replace(/s$/, "") : unit}`;
}

/** The section's saved values as the boxes show them, in page order. */
export function savedTexts<K extends NumberKey>(
	keys: readonly K[],
	settings: Record<K, number> | undefined,
): Record<K, string> | undefined {
	if (!settings) return undefined;
	const texts = {} as Record<K, string>;
	for (const key of keys) texts[key] = NUMBER_SETTINGS[key].toText(settings[key]);
	return texts;
}

/** The body for the changed fields, or what to fix, by field. */
export function numberBody<K extends NumberKey>(
	changed: readonly K[],
	text: (key: K) => string,
): { body: Partial<Record<K, number>> } | { errors: Partial<Record<K, string>> } {
	const body: Partial<Record<K, number>> = {};
	const errors: Partial<Record<K, string>> = {};
	for (const key of changed) {
		const value = NUMBER_SETTINGS[key].parse(text(key));
		if (value === null) errors[key] = NUMBER_SETTINGS[key].error;
		else body[key] = value;
	}
	return Object.keys(errors).length > 0 ? { errors } : { body };
}
