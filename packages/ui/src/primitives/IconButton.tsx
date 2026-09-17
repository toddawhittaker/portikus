import * as Tooltip from "@radix-ui/react-tooltip";
import type * as React from "react";
import { cx } from "./cx.js";
import { Icon, type IconName } from "./Icon.js";
import { type Key, ShortcutHint } from "./ShortcutHint.js";

export interface IconButtonProps
	extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
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
		<Tooltip.Provider delayDuration={400}>
			<Tooltip.Root open={tooltipOpen || undefined}>
				<Tooltip.Trigger asChild={true}>
					<button
						type="button"
						{...rest}
						className={cx(
							"pk-iconbtn pk-focus-ring relative inline-grid cursor-pointer place-items-center rounded-sm border p-0 transition-colors duration-[var(--duration-fast)] hover:bg-surface-hover hover:text-ink aria-pressed:bg-surface-selected aria-pressed:text-ink",
							variant === "secondary"
								? "border-line-strong bg-surface-raised text-ink"
								: "border-transparent bg-transparent text-ink-muted",
							size === "sm"
								? "size-[var(--size-control-sm)]"
								: "size-[var(--pk-control)]",
							className,
						)}
						aria-label={label}
					>
						<Icon name={icon} size={size === "sm" ? "sm" : "md"} />
					</button>
				</Tooltip.Trigger>
				<Tooltip.Portal>
					<Tooltip.Content
						sideOffset={6}
						className="pk-tooltip z-[var(--z-menu)] inline-flex items-center gap-2 whitespace-nowrap rounded-sm bg-surface-inverse px-2 py-1 text-[12px] font-medium leading-4 text-ink-inverse shadow-md"
					>
						{label}
						{shortcut ? <ShortcutHint keys={shortcut} plain={true} /> : null}
					</Tooltip.Content>
				</Tooltip.Portal>
			</Tooltip.Root>
		</Tooltip.Provider>
	);
}
