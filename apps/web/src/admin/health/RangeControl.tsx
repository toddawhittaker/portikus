import { HealthRange } from "@portikus/contracts";
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

/** The Health tab's range, remembered per browser (SPEC.md section 25.6). */
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
		// The student segmented control, so a chosen range never looks like a primary action.
		<fieldset className="pk-segmented pk-range">
			<legend className="sr-only">Time range</legend>
			{HealthRange.options.map((option) => (
				<button
					key={option}
					type="button"
					aria-pressed={option === range}
					onClick={() => onChange(option)}
				>
					{RANGE_LABELS[option]}
				</button>
			))}
		</fieldset>
	);
}
