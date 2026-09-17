// Temporary stand-ins for the primitives built in parallel (task D1). At merge
// these imports become "../primitives" and this file goes away.
import type * as React from "react";

export type IconName =
	| "terminal"
	| "agent"
	| "file"
	| "folder"
	| "folder-open"
	| "preview"
	| "plus"
	| "x"
	| "more"
	| "chevron-right"
	| "chevron-down"
	| "chevron-up"
	| "chevron-up-down"
	| "external"
	| "alert"
	| "check"
	| "info"
	| "search"
	| "play"
	| "stop"
	| "restart"
	| "lock"
	| "grip"
	| "storage"
	| "trash"
	| "sign-out";

export type Key = "Mod" | "Alt" | "Shift" | "Ctrl" | "Enter" | string;

export interface IconProps {
	name: IconName;
	size?: "sm" | "md" | "lg";
	label?: string;
	className?: string;
}

export function Icon({ name, label, className }: IconProps): React.ReactElement {
	if (label) {
		return (
			<span className={className} data-icon={name} role="img" aria-label={label} />
		);
	}
	return <span className={className} data-icon={name} aria-hidden="true" />;
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: "primary" | "secondary" | "quiet" | "danger";
	size?: "sm" | "md" | "lg";
	loading?: boolean;
	iconStart?: IconName;
	iconEnd?: IconName;
}

export function Button({
	variant,
	size,
	loading,
	iconStart,
	iconEnd,
	children,
	...rest
}: ButtonProps): React.ReactElement {
	return (
		<button
			type="button"
			data-variant={variant}
			data-size={size}
			data-loading={loading || undefined}
			{...rest}
		>
			{iconStart ? <Icon name={iconStart} /> : null}
			{children}
			{iconEnd ? <Icon name={iconEnd} /> : null}
		</button>
	);
}

export interface IconButtonProps
	extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
	icon: IconName;
	/** Required. Becomes aria-label and the tooltip text. */
	label: string;
	shortcut?: Key[];
	variant?: "quiet" | "secondary";
	size?: "sm" | "md";
	/** Preview only: render the tooltip open. */
	tooltipOpen?: boolean;
}

export function IconButton({
	icon,
	label,
	shortcut,
	variant,
	size,
	tooltipOpen,
	...rest
}: IconButtonProps): React.ReactElement {
	return (
		<button
			type="button"
			aria-label={label}
			data-variant={variant}
			data-size={size}
			{...rest}
		>
			<Icon name={icon} size={size} />
		</button>
	);
}
