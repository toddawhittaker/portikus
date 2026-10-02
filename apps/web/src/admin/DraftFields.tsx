import { TextField } from "@portikus/ui";
import type { Dispatch, SetStateAction } from "react";
import { announced } from "../common/announced.js";

/**
 * The numeric fields of an admin override dialog, then the server's error
 * when no field has one. Shared by the guard and limits dialogs.
 */
export function DraftFields<K extends string>({
	idPrefix,
	fields,
	drafts,
	setDrafts,
	errors,
	hint,
	layoutClassName,
	fieldClassName,
	serverError,
}: {
	/** Prefixes each field's id and test id. */
	idPrefix: string;
	fields: { key: K; label: string }[];
	drafts: Record<K, string>;
	setDrafts: Dispatch<SetStateAction<Record<K, string>>>;
	errors: Partial<Record<K, string>>;
	hint: (key: K) => string | undefined;
	layoutClassName: string;
	fieldClassName?: string;
	serverError: string | null;
}) {
	const firstError = fields.find((field) => errors[field.key])?.key;
	return (
		<>
			<div className={layoutClassName}>
				{fields.map((field) => {
					const error = errors[field.key] ?? null;
					return (
						<TextField
							key={field.key}
							id={`${idPrefix}-${field.key}`}
							label={field.label}
							inputMode="numeric"
							className={fieldClassName}
							data-testid={`${idPrefix}-${field.key}`}
							hint={hint(field.key)}
							// Only the first problem is announced, so a reader hears one alert.
							error={field.key === firstError ? announced(error) : error}
							value={drafts[field.key]}
							onChange={(event) =>
								setDrafts((now) => ({ ...now, [field.key]: event.target.value }))
							}
						/>
					);
				})}
			</div>
			{firstError === undefined && serverError ? (
				<p className="pk-text-compact m-0 mt-3 text-status-error" role="alert">
					{serverError}
				</p>
			) : null}
		</>
	);
}
