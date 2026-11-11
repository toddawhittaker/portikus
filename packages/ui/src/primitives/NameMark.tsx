import type * as React from "react";
import { cx } from "./cx.js";

/**
 * The Portikus mark: an ivory portico (pediment, lintel, two columns, a step)
 * on a teal tile, with a gold prompt and cursor in its doorway. Its colours are
 * brand tokens, so it reads the same on every surface in both themes.
 */
const TILE = "M0 8a8 8 0 0 1 8-8h16a8 8 0 0 1 8 8v16a8 8 0 0 1-8 8H8a8 8 0 0 1-8-8z";
const STONE =
	"M16 5.5 27 11.5H5z M6 12.5h20v2H6z M8 15.5h3.5v9H8z M20.5 15.5H24v9h-3.5z M5.5 25.5h21v2h-21z";
const PROMPT =
	"M12.8 17.4 16.4 20l-3.6 2.6v-1.7l1.6-.9-1.6-.9z M16.8 21.6h2.8v1.4h-2.8z";

export interface NameMarkProps {
	/** Size of the name in pixels; the mark scales with it. */
	size?: number;
	href?: string;
	markOnly?: boolean;
	className?: string;
}

export function NameMark({
	size = 20,
	href,
	markOnly,
	className,
}: NameMarkProps): React.ReactElement {
	const svg = (
		<svg
			viewBox="0 0 32 32"
			className="pk-mark block h-[1.3em] w-[1.3em] flex-none"
			aria-hidden={true}
		>
			<path fill="var(--brand-tile)" d={TILE} />
			<path fill="var(--brand-stone)" d={STONE} />
			<path fill="var(--brand-spark)" d={PROMPT} />
		</svg>
	);
	const classes = cx(
		"pk-namemark pk-focus-ring inline-flex items-center gap-[0.4em] font-sans font-bold leading-none tracking-[-0.01em] text-ink no-underline",
		className,
	);

	if (href) {
		return (
			<a
				className={classes}
				href={href}
				style={{ fontSize: `${size}px` }}
				aria-label={markOnly ? "Portikus" : undefined}
			>
				{svg}
				{markOnly ? null : <span>Portikus</span>}
			</a>
		);
	}
	if (markOnly) {
		return (
			<span
				className={classes}
				style={{ fontSize: `${size}px` }}
				role="img"
				aria-label="Portikus"
			>
				{svg}
			</span>
		);
	}
	return (
		<span className={classes} style={{ fontSize: `${size}px` }}>
			{svg}
			<span>Portikus</span>
		</span>
	);
}
