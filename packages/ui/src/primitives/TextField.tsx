import type * as React from "react";
import { cx } from "./cx.js";
import { Icon } from "./Icon.js";

export const FIELD_CLASS = "pk-field grid gap-1.5";
export const LABEL_CLASS = "pk-label text-[13px] font-medium leading-[18px] text-ink";
export const HINT_CLASS = "pk-hint m-0 text-[12px] leading-4 text-ink-muted";
export const CONTROL_CLASS =
	"pk-focus-ring box-border h-[var(--pk-control)] w-full rounded-sm border border-line-strong bg-surface-raised px-[var(--pk-pad)] text-[length:var(--pk-font)] text-ink hover:border-ink-muted";

export interface TextFieldProps
	extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "id"> {
	id: string;
	/** Forwarded to the input, for focusing or selecting it. */
	ref?: React.Ref<HTMLInputElement>;
	label: React.ReactNode;
	hint?: React.ReactNode;
	error?: React.ReactNode;
	/**
	 * A problem the field can still recover from, such as a name already in
	 * use. Shown in the warning colour; the field is not marked invalid, it
	 * just points at the warning line.
	 */
	warning?: React.ReactNode;
	/** Use for folder names, URLs, ports and typed confirmations. */
	mono?: boolean;
}

export function TextField({
	id,
	label,
	hint,
	error,
	warning,
	mono,
	className,
	...rest
}: TextFieldProps): React.ReactElement {
	const describedBy =
		[
			hint ? `${id}-hint` : null,
			error ? `${id}-err` : null,
			!error && warning ? `${id}-warn` : null,
		]
			.filter(Boolean)
			.join(" ") || undefined;
	return (
		<div className={cx(FIELD_CLASS, className)}>
			<label className={LABEL_CLASS} htmlFor={id}>
				{label}
			</label>
			<input
				type="text"
				{...rest}
				id={id}
				className={cx(
					"pk-input",
					CONTROL_CLASS,
					"placeholder:text-ink-faint disabled:border-line disabled:bg-surface-sunken disabled:text-ink-faint aria-[invalid=true]:border-status-error data-[warning=true]:border-status-warning",
					mono && "font-mono [font-variant-ligatures:none]",
				)}
				data-warning={!error && warning ? true : undefined}
				aria-invalid={error ? true : undefined}
				aria-describedby={describedBy}
			/>
			{error ? (
				<p
					className="pk-error m-0 flex items-center gap-1 text-[12px] leading-4 text-status-error"
					id={`${id}-err`}
				>
					<Icon name="alert" size="sm" />
					{error}
				</p>
			) : null}
			{!error && warning ? (
				<p
					className="pk-warning m-0 flex items-center gap-1 text-[12px] leading-4 text-status-warning"
					id={`${id}-warn`}
				>
					<Icon name="alert" size="sm" />
					{warning}
				</p>
			) : null}
			{hint ? (
				<p className={HINT_CLASS} id={`${id}-hint`}>
					{hint}
				</p>
			) : null}
		</div>
	);
}
