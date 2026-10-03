import type * as React from "react";
import { cx } from "./cx.js";
import { Icon } from "./Icon.js";

/**
 * The accessible name: a `label` string such as "Pull cache space" that
 * matches the visible row label, or the id of that visible label.
 */
type MeterName =
	| { label: string; "aria-labelledby"?: never }
	| { label?: never; "aria-labelledby": string };

export type MeterProps = MeterName & {
	value: number;
	max: number;
	/** The id of text to read after the value, such as a next step. */
	"aria-describedby"?: string;
	/** Shown beside the bar and read as its value, such as "4.1 GB of 20 GB used". */
	valueText: string;
	/** Past this value the fill turns to the warning colour and the text adds "nearly full". */
	high?: number;
	/** A value to mark with a tick, such as an automatic clear point; nearby text says what it is. */
	mark?: number;
	className?: string;
};

/**
 * The words a Meter shows and reads: `valueText`, plus "nearly full" past
 * `high` or "over the limit" past `max`. A control that wraps a Meter builds
 * its name from this, so the name holds the visible text.
 */
export function meterText({
	value,
	max,
	high,
	valueText,
}: Pick<MeterProps, "value" | "max" | "high" | "valueText">): string {
	// Strictly past, as the native meter colours it.
	if (max > 0 && value > max) return `${valueText}, over the limit`;
	if (high !== undefined && value > high) return `${valueText}, nearly full`;
	return valueText;
}

/**
 * A native meter with its value as text beside it, so the figure can be read
 * and copied (SPEC.md section 25.8). The text wraps under the bar when narrow.
 * Past `high` the text gains the alert icon and "nearly full", or "over the
 * limit" past `max`, so colour is not the only sign.
 */
export function Meter({
	value,
	max,
	label,
	"aria-labelledby": labelledBy,
	"aria-describedby": describedBy,
	valueText,
	high,
	mark,
	className,
}: MeterProps): React.ReactElement {
	const text = meterText({ value, max, high, valueText });
	const warn = text !== valueText;
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
					aria-labelledby={labelledBy}
					aria-describedby={describedBy}
					aria-valuetext={text}
				/>
				{markAt === null ? null : (
					<span
						className="pk-meter-mark"
						aria-hidden={true}
						style={{ insetInlineStart: `${markAt}%` }}
					/>
				)}
			</span>
			{/* The meter's aria-valuetext already reads these words. */}
			<span className="pk-meter-text" aria-hidden={true}>
				{warn ? <Icon name="alert" size="sm" className="pk-meter-alert" /> : null}
				<span className="pk-meter-figure">{text}</span>
			</span>
		</span>
	);
}
