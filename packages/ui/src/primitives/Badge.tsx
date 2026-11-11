import type * as React from "react";
import { cx } from "./cx.js";

export type BadgeTone =
	| "success"
	| "warning"
	| "danger"
	| "info"
	| "neutral"
	| "accent"
	| "agent";

const TONE_TEXT: Record<BadgeTone, string> = {
	success: "text-status-running",
	warning: "text-status-warning",
	danger: "text-status-error",
	info: "text-status-starting",
	neutral: "text-status-stopped",
	accent: "text-accent-text",
	agent: "text-agent-text",
};

const TONE_FILL: Record<BadgeTone, string> = {
	success: "bg-status-running-soft",
	warning: "bg-status-warning-soft",
	danger: "bg-status-error-soft",
	info: "bg-status-starting-soft",
	neutral: "bg-status-stopped-soft",
	accent: "bg-accent-soft",
	agent: "bg-agent-soft",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
	tone: BadgeTone;
	/** Drops the fill and the padding, for a status bar. */
	plain?: boolean;
}

/** A short status label: one height, radius and type for every status in the product. */
export function Badge({
	tone,
	plain,
	className,
	...rest
}: BadgeProps): React.ReactElement {
	return (
		<span
			{...rest}
			data-tone={tone}
			className={cx(
				"pk-badge box-border inline-flex h-[var(--size-badge)] min-w-[var(--size-badge)] flex-none items-center justify-center gap-1.5 whitespace-nowrap rounded-sm font-sans text-[length:var(--text-xs)] font-semibold leading-[var(--leading-xs)]",
				TONE_TEXT[tone],
				plain ? "px-0" : cx(TONE_FILL[tone], "px-2"),
				className,
			)}
		/>
	);
}
