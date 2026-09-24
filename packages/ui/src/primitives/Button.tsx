import type * as React from "react";
import { cx } from "./cx.js";
import { Icon, type IconName } from "./Icon.js";

const VARIANT_CLASS = {
	primary: "bg-surface-inverse text-ink-inverse hover:bg-surface-inverse-hover",
	secondary: "bg-surface-raised text-ink border-line-strong hover:bg-surface-hover",
	quiet: "bg-transparent text-ink hover:bg-surface-hover",
	danger: "bg-status-danger text-on-danger hover:bg-danger-hover",
} as const;

const SIZE_CLASS = {
	sm: "h-[var(--size-control-sm)] px-2 text-[13px]",
	md: "h-[var(--pk-control)] px-[var(--pk-pad)] text-[length:var(--pk-font)]",
	lg: "h-[var(--size-control-lg)] px-5 text-[15px]",
} as const;

export interface ButtonProps extends React.ComponentPropsWithRef<"button"> {
	variant?: "primary" | "secondary" | "quiet" | "danger";
	size?: "sm" | "md" | "lg";
	/** Keeps the label and colour, adds the spinner and aria-busy, and ignores clicks. */
	loading?: boolean;
	iconStart?: IconName;
	iconEnd?: IconName;
}

export function Button({
	variant = "secondary",
	size = "md",
	loading,
	iconStart,
	iconEnd,
	className,
	children,
	onClick,
	...rest
}: ButtonProps): React.ReactElement {
	return (
		<button
			type="button"
			{...rest}
			className={cx(
				"pk-btn pk-focus-ring inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border border-transparent font-semibold leading-none transition-colors duration-[var(--duration-fast)]",
				VARIANT_CLASS[variant],
				SIZE_CLASS[size],
				className,
			)}
			aria-busy={loading ? true : undefined}
			aria-disabled={loading ? true : rest["aria-disabled"]}
			onClick={(event) => {
				// Stays focusable while busy, so a repeat click must be dropped here.
				if (loading) {
					event.preventDefault();
					return;
				}
				onClick?.(event);
			}}
		>
			{loading ? (
				<span className="pk-spin" aria-hidden={true} />
			) : iconStart ? (
				<Icon name={iconStart} />
			) : null}
			{children}
			{iconEnd ? <Icon name={iconEnd} /> : null}
		</button>
	);
}
