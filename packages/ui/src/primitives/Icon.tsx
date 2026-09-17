import type * as React from "react";
import { cx } from "./cx.js";

/**
 * The outlined icon set from design/system/components/Icon, drawn on a 24 grid at
 * a 1.75 stroke. Shapes are encoded the way the design system encodes them: a
 * leading R, C or E is a rect, circle or ellipse, anything else is a path.
 */
const PATHS = {
	terminal: ["R3 4 18 16 1.5", "M7 9l3 3-3 3", "M12.5 15H17"],
	agent: [
		"M12 3v5",
		"M12 16v5",
		"M3 12h5",
		"M16 12h5",
		"M5.6 5.6l3.2 3.2",
		"M15.2 15.2l3.2 3.2",
		"M5.6 18.4l3.2-3.2",
		"M15.2 8.8l3.2-3.2",
	],
	file: ["M6 3h8l4 4v14H6z", "M14 3v4h4"],
	folder: [
		"M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z",
	],
	"folder-open": [
		"M3 17.5v-11A1.5 1.5 0 0 1 4.5 5H9l2 2h7.5A1.5 1.5 0 0 1 20 8.5V10",
		"M3 17.5 5.6 11a1.5 1.5 0 0 1 1.4-1h13.2a1 1 0 0 1 .9 1.4l-2.6 6.7a1.5 1.5 0 0 1-1.4.9H4.5A1.5 1.5 0 0 1 3 17.5z",
	],
	preview: ["R3 4 18 16 1.5", "M3 9h18", "M6.5 6.5h.01", "M9 6.5h.01"],
	plus: ["M12 5v14", "M5 12h14"],
	x: ["M6.5 6.5l11 11", "M17.5 6.5l-11 11"],
	more: ["M6 12h.01", "M12 12h.01", "M18 12h.01"],
	"chevron-right": ["M9.5 6l6 6-6 6"],
	"chevron-down": ["M6 9.5l6 6 6-6"],
	"chevron-up": ["M6 14.5l6-6 6 6"],
	"chevron-up-down": ["M8 9.5l4-4 4 4", "M8 14.5l4 4 4-4"],
	external: [
		"M14 4h6v6",
		"M20 4l-8.5 8.5",
		"M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
	],
	alert: [
		"M10.3 4.3 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z",
		"M12 9.5v4",
		"M12 17h.01",
	],
	check: ["M5 12.5l4.5 4.5L19 7.5"],
	info: ["C12 12 9", "M12 11v5", "M12 8h.01"],
	search: ["C11 11 6.5", "M20 20l-4.4-4.4"],
	play: ["M8 5.5v13l10.5-6.5z"],
	stop: ["R6.5 6.5 11 11 1"],
	restart: ["M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4 9.5", "M4 4.5v5h5"],
	lock: ["R5 11 14 10 1.5", "M8 11V8a4 4 0 0 1 8 0v3"],
	grip: ["M9 6h.01", "M15 6h.01", "M9 12h.01", "M15 12h.01", "M9 18h.01", "M15 18h.01"],
	storage: [
		"E12 6 8 3",
		"M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6",
		"M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
	],
	trash: [
		"M4 7h16",
		"M9.5 7V4.5h5V7",
		"M6.5 7l.8 12.2a1 1 0 0 0 1 .8h7.4a1 1 0 0 0 1-.8L17.5 7",
	],
	"sign-out": [
		"M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4",
		"M10 16l4-4-4-4",
		"M14 12H4",
	],
} satisfies Record<string, string[]>;

export type IconName = keyof typeof PATHS;

/** Names whose dots are drawn heavier so they read at 16px. */
const HEAVY_DOTS: Partial<Record<IconName, boolean>> = { more: true, grip: true };

const SIZE_CLASS = {
	sm: "size-[var(--size-icon-sm)]",
	md: "size-[var(--size-icon-md)]",
	lg: "size-[var(--size-icon-lg)]",
} as const;

export interface IconProps {
	name: IconName;
	size?: "sm" | "md" | "lg";
	/** Set only when the icon carries meaning on its own; otherwise it is hidden. */
	label?: string;
	className?: string;
}

function shape(name: IconName, d: string, key: number): React.ReactElement {
	const numbers = d.slice(1).split(" ").map(Number);
	if (d.startsWith("R")) {
		return (
			<rect
				key={key}
				x={numbers[0]}
				y={numbers[1]}
				width={numbers[2]}
				height={numbers[3]}
				rx={numbers[4]}
			/>
		);
	}
	if (d.startsWith("C")) {
		return <circle key={key} cx={numbers[0]} cy={numbers[1]} r={numbers[2]} />;
	}
	if (d.startsWith("E")) {
		return (
			<ellipse
				key={key}
				cx={numbers[0]}
				cy={numbers[1]}
				rx={numbers[2]}
				ry={numbers[3]}
			/>
		);
	}
	const isDot = /h\.01$/.test(d);
	return (
		<path
			key={key}
			d={d}
			strokeWidth={isDot ? (HEAVY_DOTS[name] ? 2.6 : 2.2) : undefined}
		/>
	);
}

export function Icon({
	name,
	size = "md",
	label,
	className,
}: IconProps): React.ReactElement {
	return (
		<svg
			className={cx(
				"pk-icon shrink-0 fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.75]",
				SIZE_CLASS[size],
				className,
			)}
			viewBox="0 0 24 24"
			aria-hidden={label ? undefined : true}
			role={label ? "img" : undefined}
			aria-label={label}
		>
			{PATHS[name].map((d, i) => shape(name, d, i))}
		</svg>
	);
}
