import type * as React from "react";
import { cx } from "./cx.js";
import { FieldMessages, fieldDescribedBy } from "./FieldMessages.js";

export { HINT_CLASS } from "./FieldMessages.js";
export const FIELD_CLASS = "pk-field grid gap-1.5";
export const LABEL_CLASS = "pk-label text-[13px] font-medium leading-[18px] text-ink";
/** A control's look without its width, for a control that sets its own. */
const CONTROL_SURFACE_CLASS =
	"pk-focus-ring box-border h-[var(--pk-control)] rounded-sm border border-line-strong bg-surface-raised px-[var(--pk-pad)] text-[length:var(--pk-font)] text-ink hover:border-ink-muted";
export const CONTROL_CLASS = `${CONTROL_SURFACE_CLASS} w-full`;

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
	/**
	 * What the number is counted in, such as "minutes". Shown after the box
	 * and read as part of the field's description.
	 */
	unit?: string;
}

type TextInputProps = Omit<TextFieldProps, "label" | "help" | "unit"> & {
	/** Set when a unit element with the id `${id}-unit` sits beside the input. */
	hasUnit?: boolean;
};

/** The input and its states; the width is the caller's, through `className`. */
function TextInput({
	id,
	hint,
	error,
	warning,
	mono,
	hasUnit,
	className,
	...rest
}: TextInputProps): React.ReactElement {
	return (
		<input
			type="text"
			{...rest}
			id={id}
			className={cx(
				"pk-input",
				CONTROL_SURFACE_CLASS,
				"placeholder:text-ink-faint disabled:border-line disabled:bg-surface-sunken disabled:text-ink-faint aria-[invalid=true]:border-status-error data-[warning=true]:border-status-warning",
				mono && "font-mono [font-variant-ligatures:none]",
				className,
			)}
			data-warning={!error && warning ? true : undefined}
			aria-invalid={error ? true : undefined}
			aria-describedby={fieldDescribedBy({ id, hint, error, warning, unit: hasUnit })}
		/>
	);
}

export type UnitInputProps = Omit<TextInputProps, "hasUnit" | "className"> & {
	unit: string;
};

/**
 * A narrow number box with its unit after it. The unit is part of the box's
 * description, so a screen reader hears "10, minutes". `hint`, `error` and
 * `warning` only link the box to messages the caller renders with
 * `FieldMessages` and the same `id`; size the box with `[&_input]:w-*` on a
 * parent.
 */
export function UnitInput({ unit, id, ...rest }: UnitInputProps): React.ReactElement {
	return (
		<span className="flex min-w-0 items-center gap-2">
			<TextInput
				inputMode="numeric"
				{...rest}
				id={id}
				hasUnit
				className="w-[5.5rem] min-w-0 text-end tabular-nums"
			/>
			<span
				id={`${id}-unit`}
				className="shrink-0 text-[length:var(--pk-font)] text-ink-muted"
			>
				{unit}
			</span>
		</span>
	);
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
	unit,
	className,
	...rest
}: TextFieldProps): React.ReactElement {
	const inputProps = { ...rest, id, hint, error, warning, mono };
	return (
		<div className={cx(FIELD_CLASS, className)}>
			<FieldLabel help={help}>
				<label className={LABEL_CLASS} htmlFor={id}>
					{label}
				</label>
			</FieldLabel>
			{unit ? (
				<UnitInput {...inputProps} unit={unit} />
			) : (
				<TextInput {...inputProps} className="w-full" />
			)}
			<FieldMessages id={id} hint={hint} error={error} warning={warning} />
		</div>
	);
}
