import type * as React from "react";
import { cx } from "./cx.js";
import { Icon, type IconName } from "./Icon.js";
import { type Key, ShortcutHint } from "./ShortcutHint.js";
import { Tooltip } from "./Tooltip.js";

export interface IconButtonProps
	extends Omit<React.ComponentPropsWithRef<"button">, "children"> {
	icon: IconName;
	/** Required. Becomes aria-label and the tooltip text. */
	label: string;
	shortcut?: Key[];
	variant?: "quiet" | "secondary";
	size?: "sm" | "md";
	/** Render the tooltip open; used by previews and tests. */
	tooltipOpen?: boolean;
}

export function IconButton({
	icon,
	label,
	shortcut,
	variant = "quiet",
	size = "md",
	tooltipOpen,
	className,
	...rest
}: IconButtonProps): React.ReactElement {
	return (
		<Tooltip
			open={tooltipOpen || undefined}
			content={
				<>
					{label}
					{shortcut ? <ShortcutHint keys={shortcut} plain={true} /> : null}
				</>
			}
		>
			<button
				type="button"
				{...rest}
				className={cx(
					"pk-iconbtn pk-focus-ring relative inline-grid cursor-pointer place-items-center rounded-sm border p-0 transition-colors duration-[var(--duration-fast)] hover:bg-surface-hover hover:text-ink aria-pressed:bg-surface-selected aria-pressed:text-ink",
					variant === "secondary"
						? "border-line-strong bg-surface-raised text-ink"
						: "border-transparent bg-transparent text-ink-muted",
					size === "sm" ? "size-[var(--size-control-sm)]" : "size-[var(--pk-control)]",
					className,
				)}
				aria-label={label}
			>
				<Icon name={icon} size={size === "sm" ? "sm" : "md"} />
			</button>
		</Tooltip>
	);
}
