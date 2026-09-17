import type * as React from "react";
import { cx } from "./cx.js";

/**
 * The Portikus mark: a portico (lintel, two columns, a base line) framing a small
 * terminal. The stone follows the text colour; the room stays dark in both themes.
 */
const MARK = {
	full: {
		box: "0 0 96 48",
		stone:
			"M0 0h96v6h-96z M2 7L17 7L16 11L3 11z M4 11h11v26h-11z M3 37L16 37L17 41L2 41z M79 7L94 7L93 11L80 11z M81 11h11v26h-11z M80 37L93 37L94 41L79 41z M0 42h96v6h-96z",
		room: "M20 11h56v28h-56z",
		code: "M25 16h39v2.5h-39z M25 21h22v2.5h-22z M25 26h30v2.5h-30z",
		cursor: "M25 31h3v5.5h-3z",
		sizeClass: "h-[1.08em] w-[2.16em]",
	},
	compact: {
		box: "0 0 32 32",
		stone: "M1 4h30v3H1z M3 8h4v16H3z M25 8h4v16h-4z M1 25h30v3H1z",
		room: "M9 8h14v16H9z",
		code: "M11 11h8v2h-8z M11 15h5v2h-5z",
		cursor: "M11 19h2v3h-2z",
		sizeClass: "h-[1.2em] w-[1.2em]",
	},
} as const;

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
	const mark = MARK[markOnly && size < 24 ? "compact" : "full"];
	const svg = (
		<svg
			viewBox={mark.box}
			className={cx("pk-mark block flex-none", mark.sizeClass)}
			aria-hidden={true}
		>
			<path className="fill-current" d={mark.stone} />
			<path className="fill-terminal-bg" d={mark.room} />
			<path className="fill-mark-code" d={mark.code} />
			<path className="fill-terminal-cursor" d={mark.cursor} />
		</svg>
	);
	const classes = cx(
		"pk-namemark pk-focus-ring inline-flex items-center gap-[0.36em] font-sans font-bold leading-none tracking-[-0.01em] text-ink no-underline",
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
