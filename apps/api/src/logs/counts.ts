import {
	HEALTH_RANGE_SECONDS,
	type HealthRange,
	type LogCounts,
} from "@portikus/contracts";
import { seriesWindow } from "../health-series/range.js";
import { levelOf, parsePortikusLine } from "./filter.js";
import { type JournalReader, LogsBusyError, SCAN_TIMEOUT_MS } from "./journal.js";

const WINDOW_MS = HEALTH_RANGE_SECONDS["7d"] * 1000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Each journalctl read covers at most a day, or an hour once a day proved too slow. */
const DAY_MS = 24 * HOUR_MS;
/** One request reads at most this many slices ... */
const MAX_SLICES_PER_REQUEST = 24;
/** ... and starts no new slice after this long. */
const REQUEST_BUDGET_MS = SCAN_TIMEOUT_MS;
/** The journal's oldest entry changes only on vacuum, so look it up this often. */
const OLDEST_CHECK_MS = HOUR_MS;

interface MinuteCount {
	errors: number;
	warnings: number;
}

type Direction = "forward" | "backward";

/**
 * Error and warn lines per minute for the last 7 days, kept in memory
 * (docs/adr/0036). Counting starts with the last hour, then moves forward to
 * the present and backward to the start of the window, one time slice (a
 * day, or an hour on a slow journal) per journalctl read. A frontier moves only past time that was fully counted,
 * so a slice that hits the scan cap is read again from where it stopped.
 */
export class LogCounter {
	private readonly minutes = new Map<number, MinuteCount>();
	/** Everything in [oldestCounted, newestCounted) is counted. */
	private newestCounted: number | null = null;
	private oldestCounted: number | null = null;
	/** Slices skipped because not one entry could be read within the limit. */
	private skipped: { from: number; to: number }[] = [];
	private oldestAt: Date | null = null;
	private oldestCheckedAt: number | null = null;
	private reading = false;
	private sliceMs = DAY_MS;

	constructor(
		private readonly reader: JournalReader,
		private readonly now: () => Date = () => new Date(),
		private readonly clock: () => number = () => Date.now(),
	) {}

	/** Count what is not yet counted (unless a read is already running), then bucket for `range`. */
	async counts(range: HealthRange): Promise<LogCounts> {
		if (!this.reading) {
			this.reading = true;
			try {
				await this.catchUp();
				await this.findOldest();
			} catch (error) {
				// Busy: answer from memory; the next request reads on.
				if (!(error instanceof LogsBusyError)) throw error;
			} finally {
				this.reading = false;
			}
		}
		return this.bucket(range);
	}

	private async catchUp(): Promise<void> {
		const now = this.now().getTime();
		const present = Math.floor(now / 1000) * 1000;
		const windowStart = now - WINDOW_MS;
		if (this.newestCounted === null || this.oldestCounted === null) {
			const start = Math.floor((now - HOUR_MS) / MINUTE_MS) * MINUTE_MS;
			this.newestCounted = start;
			this.oldestCounted = start;
		}
		const started = this.clock();
		for (let slice = 0; slice < MAX_SLICES_PER_REQUEST; slice++) {
			if (slice > 0 && this.clock() - started >= REQUEST_BUDGET_MS) break;
			if (this.newestCounted < present) {
				const to = Math.min(this.newestCounted + this.sliceMs, present);
				this.newestCounted = await this.countSlice(this.newestCounted, to, "forward");
			} else if (this.oldestCounted > windowStart) {
				const from = Math.max(this.oldestCounted - this.sliceMs, windowStart);
				this.oldestCounted = await this.countSlice(
					from,
					this.oldestCounted,
					"backward",
				);
			} else break;
		}
		for (const minute of this.minutes.keys()) {
			if (minute + MINUTE_MS <= windowStart) this.minutes.delete(minute);
		}
		this.skipped = this.skipped.filter((gap) => gap.to > windowStart);
	}

	/**
	 * Count [from, to) and return the new frontier: the far end when the read
	 * finished, or the last entry's time when it hit the scan cap. journalctl's
	 * --since and --until are whole seconds (rounded outwards) and inclusive,
	 * so entries outside [from, to) are dropped here.
	 */
	private async countSlice(
		from: number,
		to: number,
		direction: Direction,
	): Promise<number> {
		const seen: { at: number; level: "error" | "warn" }[] = [];
		let lastAt: number | undefined;
		const result = await this.reader.read(
			{
				reverse: direction === "backward",
				levels: ["error", "warn"],
				since: new Date(from),
				until: new Date(to),
			},
			(entry) => {
				const at = entry.at.getTime();
				if (at < from || at >= to) return "continue";
				lastAt = at;
				const line = parsePortikusLine(entry.message);
				const level = line ? levelOf(line.level) : null;
				if (level === "error" || level === "warn") seen.push({ at, level });
				return "continue";
			},
		);
		if (result.reason === "end") {
			for (const hit of seen) this.add(hit.at, hit.level);
			return direction === "forward" ? to : from;
		}
		// The cap hit: keep only entries strictly before (or after) the last
		// one read, since more entries may share its millisecond.
		const progressed =
			lastAt !== undefined &&
			(direction === "forward" ? lastAt > from : lastAt + 1 < to);
		if (!progressed) {
			// Nothing read within the limit: try again an hour at a time, and
			// pass over an hour that is still too slow, so counting never stalls.
			if (to - from > HOUR_MS) {
				this.sliceMs = HOUR_MS;
				return direction === "forward" ? from : to;
			}
			this.skipped.push({ from, to });
			return direction === "forward" ? to : from;
		}
		const stoppedAt = lastAt as number;
		for (const hit of seen) {
			if (direction === "forward" ? hit.at < stoppedAt : hit.at > stoppedAt) {
				this.add(hit.at, hit.level);
			}
		}
		return direction === "forward" ? stoppedAt : stoppedAt + 1;
	}

	private add(at: number, level: "error" | "warn"): void {
		const minute = Math.floor(at / MINUTE_MS) * MINUTE_MS;
		const count = this.minutes.get(minute) ?? { errors: 0, warnings: 0 };
		if (level === "error") count.errors++;
		else count.warnings++;
		this.minutes.set(minute, count);
	}

	/** The oldest entry the journal still holds for the three units, looked up at most hourly. */
	private async findOldest(): Promise<void> {
		const now = this.clock();
		if (this.oldestCheckedAt !== null && now - this.oldestCheckedAt < OLDEST_CHECK_MS) {
			return;
		}
		let oldest: Date | null = null;
		await this.reader.read({ reverse: false }, (entry) => {
			oldest = entry.at;
			return "stop";
		});
		this.oldestAt = oldest;
		this.oldestCheckedAt = now;
	}

	private bucket(range: HealthRange): LogCounts {
		const window = seriesWindow(range, this.now());
		const bucketMs = window.bucketSeconds * 1000;
		const from = window.from.getTime();
		const to = window.to.getTime();
		const buckets = new Map<number, MinuteCount>();
		for (const [minute, count] of this.minutes) {
			if (minute < from || minute >= to) continue;
			const at = from + Math.floor((minute - from) / bucketMs) * bucketMs;
			const sum = buckets.get(at) ?? { errors: 0, warnings: 0 };
			sum.errors += count.errors;
			sum.warnings += count.warnings;
			buckets.set(at, sum);
		}
		const windowStart = this.now().getTime() - WINDOW_MS;
		const complete =
			this.oldestCounted !== null &&
			this.oldestCounted <= windowStart &&
			this.skipped.length === 0;
		return {
			bucketSeconds: window.bucketSeconds,
			from: window.from.toISOString(),
			to: window.to.toISOString(),
			buckets: [...buckets.entries()]
				.sort(([a], [b]) => a - b)
				.map(([at, count]) => ({ at: new Date(at).toISOString(), ...count })),
			complete,
			oldestAt: this.oldestAt ? (this.oldestAt as Date).toISOString() : null,
		};
	}
}
