import type { HealthRange } from "@portikus/contracts";

/**
 * Where a chart's buckets sit in time: bucket `i` starts at
 * `from + i * bucketSeconds`. Every chart on the Health tab shares one frame
 * per range (docs/EPIC-19.md rulings 2 and 3).
 */
export interface ChartFrame {
	range: HealthRange;
	/** Start of the first bucket, in milliseconds since the epoch. */
	from: number;
	bucketSeconds: number;
	count: number;
}

export function frameOf(body: {
	range: HealthRange;
	from: string;
	to: string;
	bucketSeconds: number;
}): ChartFrame {
	const from = Date.parse(body.from);
	return {
		range: body.range,
		from,
		bucketSeconds: body.bucketSeconds,
		count: Math.round((Date.parse(body.to) - from) / (body.bucketSeconds * 1000)),
	};
}

export function bucketStart(frame: ChartFrame, index: number): number {
	return frame.from + index * frame.bucketSeconds * 1000;
}

/**
 * One value per bucket from a sparse, time-keyed list; buckets the list
 * lacks are null, which a chart draws as a gap.
 */
export function dense<T extends { at: string }>(
	frame: ChartFrame,
	points: readonly T[],
	pick: (point: T) => number | null,
): (number | null)[] {
	const values: (number | null)[] = new Array(frame.count).fill(null);
	for (const point of points) {
		const index = Math.round(
			(Date.parse(point.at) - frame.from) / (frame.bucketSeconds * 1000),
		);
		if (index >= 0 && index < frame.count) values[index] = pick(point);
	}
	return values;
}

/** 1, 2, 2.5 or 5 times a power of ten, at or above `value`. */
export function niceNumber(value: number): number {
	if (value <= 0) return 1;
	const power = 10 ** Math.floor(Math.log10(value));
	for (const step of [1, 2, 2.5, 5, 10]) {
		if (value <= step * power + 1e-9) return step * power;
	}
	return 10 * power;
}

/**
 * Y-axis ticks from 0 to a rounded top at or above `max`: three to five
 * ticks, evenly spaced.
 */
export function yTicks(max: number): number[] {
	const step = niceNumber(max / 4);
	const top = Math.max(step, Math.ceil(max / step - 1e-9) * step);
	const ticks: number[] = [];
	for (let value = 0; value <= top + step / 2; value += step) {
		ticks.push(Math.round(value * 1e6) / 1e6);
	}
	return ticks.length < 3 ? [0, top / 2, top] : ticks;
}

export const PERCENT_TICKS = [0, 25, 50, 75, 100];

/** Minutes between X-axis labels for each range. */
const LABEL_EVERY_MINUTES: Record<HealthRange, number> = {
	"1h": 10,
	"6h": 60,
	"1d": 240,
	"7d": 1440,
};

/** Bucket indexes that get an X-axis label: whole local clock steps. */
export function timeTickIndexes(frame: ChartFrame): number[] {
	const every = LABEL_EVERY_MINUTES[frame.range];
	const indexes: number[] = [];
	for (let index = 0; index < frame.count; index++) {
		const date = new Date(bucketStart(frame, index));
		const minuteOfDay = date.getHours() * 60 + date.getMinutes();
		if (minuteOfDay % every === 0) indexes.push(index);
	}
	return indexes;
}

/** An X-axis label: a clock time, or weekday and date for 7 days. */
export function timeLabel(time: number, range: HealthRange): string {
	const date = new Date(time);
	if (range === "7d") {
		return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
	}
	return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** The readout's time for one bucket, with the day at 7 days. */
export function readoutTime(time: number, range: HealthRange): string {
	const date = new Date(time);
	const clock = date.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	});
	if (range !== "7d") return clock;
	return `${date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })} ${clock}`;
}

/** How count charts name their bucket (docs/EPIC-19.md ruling 3). */
export function bucketPhrase(bucketSeconds: number): string {
	const minutes = bucketSeconds / 60;
	if (minutes === 1) return "per minute";
	if (minutes === 60) return "per hour";
	return `per ${minutes} minutes`;
}

export const RANGE_LABELS: Record<HealthRange, string> = {
	"1h": "1 hour",
	"6h": "6 hours",
	"1d": "1 day",
	"7d": "7 days",
};

/** "Now 16%, highest 18%.", from the newest and the largest value. */
export function lineSummary(
	values: readonly (number | null)[],
	format: (value: number) => string,
): string {
	const present = values.filter((value): value is number => value !== null);
	const last = present[present.length - 1];
	if (last === undefined) return "No samples in this range.";
	return `Now ${format(last)}, highest ${format(Math.max(...present))}.`;
}
