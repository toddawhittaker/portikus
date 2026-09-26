import type { LogCounts, LogCountsQuery } from "@portikus/contracts";
import { levelOf, parsePortikusLine } from "./filter.js";
import { type JournalReader, LogsBusyError } from "./journal.js";

type Range = LogCountsQuery["range"];

/** Bucket width per range; the same as the Health series route. */
export const BUCKET_SECONDS: Record<Range, number> = {
	"1h": 60,
	"6h": 300,
	"1d": 900,
	"7d": 3600,
};

const RANGE_SECONDS: Record<Range, number> = {
	"1h": 3600,
	"6h": 6 * 3600,
	"1d": 24 * 3600,
	"7d": 7 * 24 * 3600,
};

const WINDOW_MS = RANGE_SECONDS["7d"] * 1000;
const MINUTE_MS = 60_000;

interface MinuteCount {
	errors: number;
	warnings: number;
}

/**
 * Error and warn lines per minute for the last 7 days, kept in memory and
 * filled by reading forward from the last cursor read (docs/adr/0036).
 */
export class LogCounter {
	private readonly minutes = new Map<number, MinuteCount>();
	private lastCursor: string | null = null;
	private caughtUp = false;
	private oldestAt: Date | null = null;
	private reading = false;

	constructor(
		private readonly reader: JournalReader,
		private readonly now: () => Date = () => new Date(),
	) {}

	/** Read what is new (unless a read is already running), then bucket for `range`. */
	async counts(range: Range): Promise<LogCounts> {
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
		const windowStart = new Date(this.now().getTime() - WINDOW_MS);
		const result = await this.reader.read(
			this.lastCursor
				? { reverse: false, levels: ["error", "warn"], afterCursor: this.lastCursor }
				: { reverse: false, levels: ["error", "warn"], since: windowStart },
			(entry) => {
				const line = parsePortikusLine(entry.message);
				const level = line ? levelOf(line.level) : null;
				if (level !== "error" && level !== "warn") return "continue";
				const minute = Math.floor(entry.at.getTime() / MINUTE_MS) * MINUTE_MS;
				const count = this.minutes.get(minute) ?? { errors: 0, warnings: 0 };
				if (level === "error") count.errors++;
				else count.warnings++;
				this.minutes.set(minute, count);
				return "continue";
			},
		);
		if (result.lastCursor) this.lastCursor = result.lastCursor;
		this.caughtUp = result.reason === "end";
		for (const minute of this.minutes.keys()) {
			if (minute < windowStart.getTime()) this.minutes.delete(minute);
		}
	}

	/** The oldest entry the journal still holds for the three units. */
	private async findOldest(): Promise<void> {
		let oldest: Date | null = null;
		await this.reader.read({ reverse: false }, (entry) => {
			oldest = entry.at;
			return "stop";
		});
		this.oldestAt = oldest;
	}

	private bucket(range: Range): LogCounts {
		const bucketMs = BUCKET_SECONDS[range] * 1000;
		const to = Math.floor(this.now().getTime() / bucketMs) * bucketMs + bucketMs;
		const from = to - RANGE_SECONDS[range] * 1000;
		const buckets = new Map<number, MinuteCount>();
		for (const [minute, count] of this.minutes) {
			if (minute < from || minute >= to) continue;
			const at = Math.floor(minute / bucketMs) * bucketMs;
			const sum = buckets.get(at) ?? { errors: 0, warnings: 0 };
			sum.errors += count.errors;
			sum.warnings += count.warnings;
			buckets.set(at, sum);
		}
		return {
			bucketSeconds: BUCKET_SECONDS[range],
			from: new Date(from).toISOString(),
			to: new Date(to).toISOString(),
			buckets: [...buckets.entries()]
				.sort(([a], [b]) => a - b)
				.map(([at, count]) => ({ at: new Date(at).toISOString(), ...count })),
			complete: this.caughtUp,
			oldestAt: this.oldestAt ? (this.oldestAt as Date).toISOString() : null,
		};
	}
}
