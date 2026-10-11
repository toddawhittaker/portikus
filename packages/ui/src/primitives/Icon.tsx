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
	"file-code": [
		"M6 3h8l4 4v14H6z",
		"M14 3v4h4",
		"M10.5 12.5 8.5 15l2 2.5",
		"M13.5 12.5 15.5 15l-2 2.5",
	],
	"file-web": ["M6 3h8l4 4v14H6z", "M14 3v4h4", "C12 15 3", "M9 15h6", "E12 15 1.3 3"],
	"file-data": [
		"M6 3h8l4 4v14H6z",
		"M14 3v4h4",
		"E12 13 3.5 1.5",
		"M8.5 13v4c0 .8 1.6 1.5 3.5 1.5s3.5-.7 3.5-1.5v-4",
	],
	"file-markdown": [
		"M6 3h8l4 4v14H6z",
		"M14 3v4h4",
		"M8 17.5v-5l2 2.2 2-2.2v5",
		"M15.5 12.5v5",
		"M14 16l1.5 1.5L17 16",
	],
	"file-image": [
		"M6 3h8l4 4v14H6z",
		"M14 3v4h4",
		"C10 13.5 1.2",
		"M7 19l3.5-3.5 2.5 2.5 2-2 3 3",
	],
	"file-archive": [
		"M6 3h8l4 4v14H6z",
		"M14 3v4h4",
		"M11 4h1",
		"M11 7h1",
		"M11 10h1",
		"R10 13 3 4 1",
	],
	"file-config": [
		"M6 3h8l4 4v14H6z",
		"M14 3v4h4",
		"C12 15 2",
		"M12 11v1.3",
		"M12 17.7V19",
		"M8.5 15h1.3",
		"M14.2 15h1.3",
	],
	folder: [
		"M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z",
	],
	"folder-open": [
		"M3 17.5v-11A1.5 1.5 0 0 1 4.5 5H9l2 2h7.5A1.5 1.5 0 0 1 20 8.5V10",
		"M3 17.5 5.6 11a1.5 1.5 0 0 1 1.4-1h13.2a1 1 0 0 1 .9 1.4l-2.6 6.7a1.5 1.5 0 0 1-1.4.9H4.5A1.5 1.5 0 0 1 3 17.5z",
	],
	preview: ["R3 4 18 16 1.5", "M3 9h18", "M6.5 6.5h.01", "M9 6.5h.01"],
	plus: ["M12 5v14", "M5 12h14"],
	minus: ["M5 12h14"],
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
	// Lucide circle-help.
	help: ["C12 12 9", "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3", "M12 17h.01"],
	// Lucide arrow-left, arrow-right and download.
	"arrow-left": ["M12 19l-7-7 7-7", "M19 12H5"],
	"arrow-right": ["M5 12h14", "M12 5l7 7-7 7"],
	download: ["M12 15V3", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M7 10l5 5 5-5"],
	search: ["C11 11 6.5", "M20 20l-4.4-4.4"],
	play: ["M8 5.5v13l10.5-6.5z"],
	stop: ["R6.5 6.5 11 11 1"],
	mic: ["R9 3 6 11 3", "M5.5 11a6.5 6.5 0 0 0 13 0", "M12 17.5V21"],
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
	// Lucide users, activity, list, clipboard-list, globe, archive, box, layers
	// and settings, for the admin tabs.
	users: [
		"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
		"C9 7 4",
		"M22 21v-2a4 4 0 0 0-3-3.87",
		"M16 3.13a4 4 0 0 1 0 7.75",
	],
	activity: ["M22 12h-4l-3 9L9 3l-3 9H2"],
	list: ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
	"clipboard-list": [
		"R8 2 8 4 1",
		"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2",
		"M12 11h4",
		"M12 16h4",
		"M8 11h.01",
		"M8 16h.01",
	],
	globe: ["C12 12 10", "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", "M2 12h20"],
	archive: ["R2 3 20 5 1", "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8", "M10 12h4"],
	box: [
		"M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z",
		"M3.3 7l8.7 5 8.7-5",
		"M12 22V12",
	],
	layers: [
		"M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z",
		"M22 17.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65",
		"M22 12.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65",
	],
	settings: [
		"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
		"C12 12 3",
	],
	// The sign-out door with the arrow coming in, and Lucide map-pin, for the
	// Sign-in and Site address admin tabs.
	"sign-in": ["M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4", "M9 16l4-4-4-4", "M13 12H3"],
	"map-pin": [
		"M20 10c0 4.99-5.54 10.19-7.4 11.8a1 1 0 0 1-1.2 0C9.54 20.19 4 14.99 4 10a8 8 0 0 1 16 0",
		"C12 10 3",
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
			data-icon={name}
			aria-hidden={label ? undefined : true}
			role={label ? "img" : undefined}
			aria-label={label}
		>
			{PATHS[name].map((d, i) => shape(name, d, i))}
		</svg>
	);
}
