import type { HealthRange, LogCounts } from "@portikus/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ApiError } from "../../api/request.js";
import { searchFromFilters } from "../logs/filters.js";
import { useLogCounts } from "../logs/queries.js";
import { BarChart } from "./charts/BarChart.js";
import {
	bucketPhrase,
	bucketStart,
	type ChartFrame,
	frameOf,
	RANGE_LABELS,
	yTicks,
} from "./charts/scales.js";

/**
 * Errors and warnings per bucket, one value per bucket of the frame. A bucket
 * older than the journal's oldest entry is a gap; any other missing bucket had none.
 */
export function countValues(
	frame: ChartFrame,
	counts: LogCounts,
): { errors: (number | null)[]; warnings: (number | null)[] } {
	const oldest = counts.oldestAt ? Date.parse(counts.oldestAt) : null;
	const bucketMs = frame.bucketSeconds * 1000;
	const errors: (number | null)[] = [];
	const warnings: (number | null)[] = [];
	for (let index = 0; index < frame.count; index++) {
		const held = oldest !== null && bucketStart(frame, index) + bucketMs > oldest;
		errors.push(held ? 0 : null);
		warnings.push(held ? 0 : null);
	}
	for (const bucket of counts.buckets) {
		const index = Math.round((Date.parse(bucket.at) - frame.from) / bucketMs);
		if (index < 0 || index >= frame.count) continue;
		errors[index] = bucket.errors;
		warnings[index] = bucket.warnings;
	}
	return { errors, warnings };
}

function total(values: readonly (number | null)[]): number {
	return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

export function countSummary(
	errors: readonly (number | null)[],
	warnings: readonly (number | null)[],
	range: HealthRange,
	complete: boolean,
): string {
	const e = total(errors);
	const w = total(warnings);
	const text = `${e} ${e === 1 ? "error" : "errors"} and ${w} ${
		w === 1 ? "warning" : "warnings"
	} in the last ${RANGE_LABELS[range]}.`;
	return complete ? text : `${text} Still counting older lines.`;
}

/**
 * The errors chart on the Health tab (docs/EPIC-19.md ruling 37). Each bar
 * opens the Logs tab for its time span and the level picked in the bar.
 */
export function LogCharts({ range }: { range: HealthRange }) {
	const counts = useLogCounts(range);
	const navigate = useNavigate();
	const data = counts.data;
	const label = "Errors and warnings";

	if (counts.isError && !data) {
		// Not an alert: the Trends card's own failure is the one to announce.
		return (
			<figure className="m-0 min-w-0" data-testid="health-chart-logs">
				<figcaption className="pk-text-label text-ink-muted">{label}</figcaption>
				<p className="pk-text-body pk-muted m-0 mt-2 text-[13px]">
					{counts.error instanceof ApiError
						? counts.error.message
						: "Log counts could not be loaded."}
				</p>
			</figure>
		);
	}
	if (!data) return null;

	const frame = frameOf({ ...data, range });
	const { errors, warnings } = countValues(frame, data);
	const stacked = errors.map((value, index) => (value ?? 0) + (warnings[index] ?? 0));

	function open(bucketIndex: number, seriesIndex: number) {
		const start = bucketStart(frame, bucketIndex);
		void navigate({
			to: "/admin",
			search: searchFromFilters({
				levels: [seriesIndex === 1 ? "warn" : "error"],
				services: [],
				since: new Date(start).toISOString(),
				until: new Date(start + frame.bucketSeconds * 1000).toISOString(),
				q: "",
				user: "",
				workspace: "",
			}),
		});
	}

	return (
		<BarChart
			testId="health-chart-logs"
			label={`${label} ${bucketPhrase(frame.bucketSeconds)}`}
			frame={frame}
			series={[
				{ name: "Errors", tone: "error", values: errors },
				{ name: "Warnings", tone: "warning", values: warnings },
			]}
			ticks={yTicks(Math.max(1, ...stacked))}
			format={(value) => String(Math.round(value))}
			summary={countSummary(errors, warnings, range, data.complete)}
			onOpen={open}
		/>
	);
}
