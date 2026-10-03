import { FileInput, HINT_CLASS } from "@portikus/ui";
import { useState } from "react";
import {
	FIELD_ID,
	pemProblem,
	SECRET_KEPT,
	SECRET_NONE,
	type UploadDraft,
} from "./form.js";

/** One certificate's PEM files: the certificate, its chain and its private key. */
export function UploadFields({
	which,
	legend,
	covers,
	keySet,
	errors,
	onChange,
	onEdit,
}: {
	which: "site" | "preview";
	legend: string;
	covers: string;
	keySet: boolean;
	errors: Record<string, string>;
	onChange: (part: keyof UploadDraft, text: string) => void;
	onEdit: (id: string) => void;
}) {
	const part = (name: keyof UploadDraft, label: string, hint?: string) => {
		const id = FIELD_ID.upload(which, name);
		return (
			<FileField
				id={id}
				label={label}
				hint={hint}
				error={errors[id]}
				onText={(text) => {
					onEdit(id);
					onChange(name, text);
				}}
			/>
		);
	};
	return (
		<fieldset
			className="m-0 grid gap-3 border-0 p-0"
			data-testid={`cert-upload-${which}`}
		>
			<legend className="mb-1 p-0 font-medium text-[13px] text-ink">{legend}</legend>
			<p className={HINT_CLASS}>PEM files, as most authorities send them. {covers}</p>
			{part("certificate", "Certificate")}
			{part(
				"chain",
				"Intermediate chain (optional)",
				"Leave out if the certificate file already holds the chain.",
			)}
			{part("privateKey", "Private key", keySet ? SECRET_KEPT : SECRET_NONE)}
		</fieldset>
	);
}

/** A PEM file picker that reads the file and checks its format as soon as it is chosen. */
function FileField({
	id,
	label,
	hint,
	error,
	onText,
}: {
	id: string;
	label: string;
	hint?: string;
	error: string | undefined;
	onText: (text: string) => void;
}) {
	const [problem, setProblem] = useState<string | null>(null);
	// Keys the alert, so a second bad file with the same problem is read out again.
	const [picks, setPicks] = useState(0);
	return (
		<FileInput
			id={id}
			label={label}
			hint={hint}
			accept=".pem,.crt,.cer,.key,application/x-pem-file"
			error={
				problem ? (
					// Mounted afresh on each pick, so the problem is read out at once (SPEC.md section 25.8).
					<span key={picks} role="alert">
						{problem}
					</span>
				) : (
					error
				)
			}
			onChange={async (event) => {
				const file = event.target.files?.[0];
				const text = file ? await file.text() : "";
				setPicks((n) => n + 1);
				setProblem(pemProblem(text));
				onText(text);
			}}
		/>
	);
}
