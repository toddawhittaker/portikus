import type * as React from "react";
import { cx } from "./cx.js";

/** The Lucide page and its folded corner, shared by every page glyph. */
const PAGE = "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z";
const PAGE_FOLD = "M14 2v4a2 2 0 0 0 2 2h4";
/** The page with its lower half open, where a tag or mark is stamped. */
const PAGE_TOP = "M4 9V4a2 2 0 0 1 2-2h9l5 5v2";

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
	// Every page glyph is the Lucide page, 16 wide and 20 tall, which reads the
	// same size as the 18 square glyphs beside it.
	file: [PAGE, PAGE_FOLD],
	// File types, one glyph per family so they tell apart at tree size; an
	// unknown type keeps the plain page above, and source files are the page
	// with a language tag (TAGS below). Lucide code-xml, which the chat draws
	// for an edit, globe, hash, braces, image and sliders-horizontal.
	"file-code": ["M18 16l4-4-4-4", "M6 8l-4 4 4 4", "M14.5 4l-5 16"],
	"file-web": ["C12 12 9", "M12 3a13 13 0 0 0 0 18 13 13 0 0 0 0-18", "M3 12h18"],
	"file-style": ["M4 9h16", "M4 15h16", "M10 3 8 21", "M16 3l-2 18"],
	"file-data": [
		"M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1",
		"M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1",
	],
	// The Markdown mark: an M and a down arrow in a box.
	"file-markdown": [
		"R2 5 20 14 2",
		"M6 15V9l3 3 3-3v6",
		"M17 9v6",
		"M14.5 12.5 17 15l2.5-2.5",
	],
	"file-image": ["R3 3 18 18 2", "C9 9 2", "M21 15l-3.1-3.1a2 2 0 0 0-2.8 0L6 21"],
	// A zipped box: the zipper's teeth down the middle and its pull.
	"file-archive": [
		"R5 3 14 18 2",
		"M12 3v1.5",
		"M12 6.5V8",
		"M12 10v1.5",
		"R10.5 13.5 3 4 1",
	],
	"file-config": [
		"M21 4h-7",
		"M10 4H3",
		"M21 12h-9",
		"M8 12H3",
		"M21 20h-5",
		"M12 20H3",
		"M14 2v4",
		"M8 10v4",
		"M16 18v4",
	],
	// Lucide file-text: a page of lines, for word-processor and plain text.
	"file-text": [PAGE, PAGE_FOLD, "M10 9H8", "M16 13H8", "M16 17H8"],
	// Lucide sheet: a grid of cells.
	"file-sheet": ["R3 3 18 18 2", "M3 9h18", "M3 15h18", "M9 9v12", "M15 9v12"],
	// Lucide notebook, moved a point right so it centres: a ruled pad.
	"file-notebook": [
		"R5 2 16 20 2",
		"M3 6h4",
		"M3 10h4",
		"M3 14h4",
		"M3 18h4",
		"M17 2v20",
	],
	// Lucide music and video.
	"file-audio": ["M9 18V5l12-2v13", "C6 18 3", "C18 16 3"],
	"file-video": [
		"M16 13l5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 10.5",
		"R2 6 14 12 2",
	],
	// Lucide type, widened to the square: the letter T for typefaces.
	"file-font": ["M12 4v16", "M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2", "M9 20h6"],
	// A page with a padlock on it: a file a tool writes and nobody edits.
	"file-lock": [PAGE, PAGE_FOLD, "R8.5 14 7 5 1", "M10 14v-1.5a2 2 0 0 1 4 0V14"],
	// Lucide key-round, so a secret stands out from the files around it.
	"file-key": [
		"M2.6 17.4A2 2 0 0 0 2 18.8V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.2a2 2 0 0 0 1.4-.6l.8-.8a6.5 6.5 0 1 0-4-4z",
		"M16.5 7.5h.01",
	],
	// Lucide database: a three-tier drum, so a binary database never reads
	// as the sql script page.
	"file-database": ["E12 5 9 3", "M3 5v14a9 3 0 0 0 18 0V5", "M3 12a9 3 0 0 0 18 0"],
	// Lucide binary: ones and noughts, for compiled output that will not open
	// as text.
	"file-binary": [
		"R14 14 4 6 2",
		"R6 4 4 6 2",
		"M6 20h4",
		"M14 10h4",
		"M6 14h2v6",
		"M14 4h2v6",
	],
	// Lucide presentation: a screen on a stand, beside the text and sheet glyphs.
	"file-slides": [
		"M2 3h20",
		"M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3",
		"M7 21l5-5 5 5",
	],
	// Lucide scroll-text: a running record, apart from file-text's page.
	"file-log": [
		"M15 12h-5",
		"M15 8h-5",
		"M19 17V5a2 2 0 0 0-2-2H4",
		"M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3",
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
	// Lucide pencil: edit, rename.
	pencil: [
		"M21.2 6.8a1 1 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8l-1.3 4.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5z",
		"M15 5l4 4",
	],
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
	// Lucide bell: the notifications count in the header.
	bell: ["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"],
	info: ["C12 12 9", "M12 11v5", "M12 8h.01"],
	// Lucide circle-help.
	help: ["C12 12 9", "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3", "M12 17h.01"],
	// Lucide arrow-left, arrow-right and download.
	"arrow-left": ["M12 19l-7-7 7-7", "M19 12H5"],
	"arrow-right": ["M5 12h14", "M12 5l7 7-7 7"],
	// Lucide arrow-up: Send in the chat composer.
	"arrow-up": ["M5 12l7-7 7 7", "M12 19V5"],
	download: ["M12 15V3", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M7 10l5 5 5-5"],
	search: ["C11 11 6.5", "M20 20l-4.4-4.4"],
	play: ["M8 5.5v13l10.5-6.5z"],
	stop: ["R6.5 6.5 11 11 1"],
	mic: ["R9 3 6 11 3", "M5.5 11a6.5 6.5 0 0 0 13 0", "M12 17.5V21"],
	// Lucide volume-2: reading a reply aloud.
	speaker: [
		"M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z",
		"M16 9a5 5 0 0 1 0 6",
		"M19.4 18.4a9 9 0 0 0 0-12.8",
	],
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
	shield: [
		"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
	],
	school: ["M22 10 12 5 2 10l10 5 10-5z", "M6 12v5c3 2 9 2 12 0v-5"],
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
	// Lucide copy, for copying a command or value to the clipboard.
	copy: ["R8 8 14 14 2", "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"],
	"map-pin": [
		"M20 10c0 4.99-5.54 10.19-7.4 11.8a1 1 0 0 1-1.2 0C9.54 20.19 4 14.99 4 10a8 8 0 0 1 16 0",
		"C12 10 3",
	],
} satisfies Record<string, string[]>;

/**
 * Source files, and PDFs: the open-bottom page stamped with a short tag. The
 * tag is drawn as text so it stays a word, never a vendor logo.
 */
const TAGS = {
	"file-pdf": "pdf",
	"file-python": "py",
	"file-java": "jv",
	"file-javascript": "js",
	"file-typescript": "ts",
	"file-c": "c",
	"file-cpp": "c++",
	"file-sql": "sql",
	"file-shell": "sh",
	"file-go": "go",
	"file-rust": "rs",
	"file-csharp": "c#",
	"file-ruby": "rb",
	"file-php": "php",
	"file-kotlin": "kt",
	"file-swift": "sw",
} as const;

export type IconName = keyof typeof PATHS | keyof typeof TAGS;

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

function tagged(tag: string): React.ReactElement[] {
	return [
		<path key="page" d={PAGE_TOP} />,
		<path key="fold" d={PAGE_FOLD} />,
		<text
			key="tag"
			x={12}
			y={20.5}
			textAnchor="middle"
			fill="currentColor"
			stroke="none"
			fontSize={tag.length > 2 ? 11 : 13}
			fontWeight={700}
			// Long tags are fitted to the glyph's width so every icon stays one size.
			textLength={tag.length > 2 ? 20 : undefined}
			lengthAdjust="spacingAndGlyphs"
		>
			{tag}
		</text>,
	];
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
			{name in TAGS
				? tagged(TAGS[name as keyof typeof TAGS])
				: PATHS[name as keyof typeof PATHS].map((d, i) => shape(name, d, i))}
		</svg>
	);
}
