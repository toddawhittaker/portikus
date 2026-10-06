import {
	CONTROL_CLASS,
	FIELD_CLASS,
	FieldMessages,
	fieldDescribedBy,
	LABEL_CLASS,
} from "@portikus/ui";

/** A labelled multi-line field with a hint and an error, laid out as TextField is. */
export function TextAreaField({
	id,
	label,
	hint,
	error,
	rows,
	mono = false,
	className = "",
	value,
	onChange,
}: {
	id: string;
	label: string;
	hint?: string;
	error: string | undefined;
	rows: number;
	mono?: boolean;
	className?: string;
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<div className={`${FIELD_CLASS} ${className}`}>
			<label className={LABEL_CLASS} htmlFor={id}>
				{label}
			</label>
			<textarea
				id={id}
				className={`${CONTROL_CLASS} h-auto py-2 aria-[invalid=true]:border-status-error ${mono ? "font-mono" : ""}`}
				rows={rows}
				autoComplete="off"
				spellCheck={false}
				value={value}
				aria-invalid={error ? true : undefined}
				aria-describedby={fieldDescribedBy({ id, hint, error })}
				onChange={(event) => onChange(event.target.value)}
			/>
			<FieldMessages id={id} hint={hint} error={error} />
		</div>
	);
}
