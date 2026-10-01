import type * as React from "react";
import { cx } from "./cx.js";

export interface MeterProps {
	value: number;
	max: number;
	/** The accessible name, such as "Pull cache space". */
	label: string;
	/** Shown beside the bar and read as its value, such as "4.1 GB of 20 GB used". */
	valueText: string;
	/** From this value up the fill turns to the warning colour. */
	high?: number;
	/** A value to mark with a tick, such as an automatic clear point; nearby text says what it is. */
	mark?: number;
	className?: string;
}

/**
 * A native meter with its value as text beside it, so the figure can be read
 * and copied (SPEC.md section 25.8). The text wraps under the bar when narrow.
 */
export function Meter({
	value,
	max,
	label,
	valueText,
	high,
	mark,
	className,
}: MeterProps): React.ReactElement {
	const markAt =
		mark !== undefined && max > 0 ? Math.min(Math.max(mark / max, 0), 1) * 100 : null;
	return (
		<span className={cx("pk-meter-line", className)}>
			<span className="pk-meter-wrap">
				<meter
					className="pk-meter-bar"
					min={0}
					max={max > 0 ? max : 1}
					value={Math.max(value, 0)}
					high={high}
					aria-label={label}
					aria-valuetext={valueText}
				/>
				{markAt === null ? null : (
					<span
						className="pk-meter-mark"
						aria-hidden={true}
						style={{ insetInlineStart: `${markAt}%` }}
					/>
				)}
			</span>
			<span className="pk-meter-text">{valueText}</span>
		</span>
	);
}
