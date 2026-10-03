import type * as React from "react";
import { cx } from "./cx.js";
import { Icon } from "./Icon.js";
import { CONTROL_CLASS, FIELD_CLASS, HINT_CLASS, LABEL_CLASS } from "./TextField.js";

export interface FileInputProps
	extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "id" | "type"> {
	id: string;
	label: React.ReactNode;
	hint?: React.ReactNode;
	error?: React.ReactNode;
}

/**
 * A native file input drawn as a Select-sized control: the picker button sits
 * flush inside the box and the chosen file's name follows it. The native
 * element keeps the keyboard, drop target and file name for free.
 */
export function FileInput({
	id,
	label,
	hint,
	error,
	className,
	...rest
}: FileInputProps): React.ReactElement {
	const describedBy =
		[error ? `${id}-err` : null, hint ? `${id}-hint` : null]
			.filter(Boolean)
			.join(" ") || undefined;
	return (
		<div className={cx(FIELD_CLASS, className)}>
			<label className={LABEL_CLASS} htmlFor={id}>
				{label}
			</label>
			<input
				{...rest}
				type="file"
				id={id}
				className={cx(
					"pk-file-input",
					CONTROL_CLASS,
					// The button fills the box's start edge, so the box needs no start padding.
					"cursor-pointer overflow-hidden ps-0 aria-[invalid=true]:border-status-error",
					"file:me-3 file:h-full file:cursor-pointer file:border-0 file:border-e file:border-line-strong file:border-solid file:bg-surface-sunken file:px-[var(--pk-pad)] file:font-medium file:font-sans file:text-[length:var(--pk-font)] file:text-ink hover:file:bg-surface-hover",
				)}
				aria-invalid={error ? true : undefined}
				aria-describedby={describedBy}
			/>
			{error ? (
				<p
					className="pk-error m-0 flex items-center gap-1 text-[12px] leading-4 text-status-error [overflow-wrap:anywhere]"
					id={`${id}-err`}
				>
					<Icon name="alert" size="sm" />
					{error}
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
