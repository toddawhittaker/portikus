import { HealthRange } from "@portikus/contracts";
import { Button } from "@portikus/ui";
import { useState } from "react";
import { RANGE_LABELS } from "./charts/scales.js";

export const RANGE_STORAGE_KEY = "portikus.admin.healthRange";

/** The remembered range, or 1 day; storage may be missing or refuse. */
export function readStoredRange(): HealthRange {
	try {
		const parsed = HealthRange.safeParse(localStorage.getItem(RANGE_STORAGE_KEY));
		return parsed.success ? parsed.data : "1d";
	} catch {
		return "1d";
	}
}

/** The Health tab's range, remembered per browser (docs/EPIC-19.md ruling 5). */
export function useHealthRange(): [HealthRange, (range: HealthRange) => void] {
	const [range, setRange] = useState<HealthRange>(readStoredRange);
	function choose(next: HealthRange) {
		setRange(next);
		try {
			localStorage.setItem(RANGE_STORAGE_KEY, next);
		} catch {
			// A browser that refuses storage still switches for this visit.
		}
	}
	return [range, choose];
}

export function RangeControl({
	range,
	onChange,
}: {
	range: HealthRange;
	onChange: (range: HealthRange) => void;
}) {
	return (
		<fieldset className="pk-actions m-0 border-0 p-0">
			<legend className="sr-only">Time range</legend>
			{HealthRange.options.map((option) => (
				<Button
					key={option}
					size="sm"
					variant={option === range ? "primary" : "secondary"}
					aria-pressed={option === range}
					onClick={() => onChange(option)}
				>
					{RANGE_LABELS[option]}
				</Button>
			))}
		</fieldset>
	);
}
