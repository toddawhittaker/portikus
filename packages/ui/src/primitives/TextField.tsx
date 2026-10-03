import type * as React from "react";
import { cx } from "./cx.js";
import { FieldMessages, fieldDescribedBy } from "./FieldMessages.js";

export { HINT_CLASS } from "./FieldMessages.js";
export const FIELD_CLASS = "pk-field grid gap-1.5";
export const LABEL_CLASS = "pk-label text-[13px] font-medium leading-[18px] text-ink";
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
	/** A Toggletip, shown beside the label and never inside it. */
	help?: React.ReactNode;
}

/**
 * The label row with a help button beside the label. The row keeps the label's
 * 18px line and the 24px button overflows it evenly, so a field with help lines
 * up with one without (the target stays 24px, WCAG 2.5.8).
 */
const LABEL_ROW_CLASS = "flex h-[18px] min-w-0 items-center gap-1";

/** The label row: the label, then a help button beside it when there is one. */
export function FieldLabel({
	help,
	children,
}: {
	help?: React.ReactNode;
	children: React.ReactElement;
}): React.ReactElement {
	if (!help) return children;
	return (
		<div className={LABEL_ROW_CLASS}>
			{children}
			{help}
		</div>
	);
}

export function TextField({
	id,
	label,
	hint,
	error,
	warning,
	mono,
	help,
	className,
	...rest
}: TextFieldProps): React.ReactElement {
	return (
		<div className={cx(FIELD_CLASS, className)}>
			<FieldLabel help={help}>
				<label className={LABEL_CLASS} htmlFor={id}>
					{label}
				</label>
			</FieldLabel>
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
				aria-describedby={fieldDescribedBy({ id, hint, error, warning })}
			/>
			<FieldMessages id={id} hint={hint} error={error} warning={warning} />
		</div>
	);
}
