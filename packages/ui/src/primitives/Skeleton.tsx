import type * as React from "react";
import { cx } from "./cx.js";

const BASE = "pk-skel block bg-surface-hover";

const VARIANT_CLASS = {
	text: "rounded-xs h-2.5 my-[5px]",
	block: "rounded-xs",
	circle: "rounded-full",
} as const;

export interface SkeletonProps {
	variant?: "text" | "block" | "circle";
	width?: number | string;
	height?: number | string;
	/** Renders a paragraph of this many text bars. */
	lines?: number;
	className?: string;
}

export function Skeleton({
	variant = "text",
	width,
	height,
	lines,
	className,
}: SkeletonProps): React.ReactElement {
	if (variant === "text" && lines && lines > 1) {
		return (
			<span
				className={cx("pk-skel-stack grid gap-1", className)}
				aria-hidden={true}
				style={{ width }}
			>
				{Array.from({ length: lines }, (_, i) => (
					<span
						// Bars are a fixed-length placeholder with no identity but position.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above
						key={i}
						className={cx(BASE, VARIANT_CLASS.text)}
						style={{ width: i === lines - 1 ? "60%" : "100%" }}
					/>
				))}
			</span>
		);
	}
	return (
		<span
			className={cx(BASE, VARIANT_CLASS[variant], className)}
			aria-hidden={true}
			style={{ width, height }}
		/>
	);
}
