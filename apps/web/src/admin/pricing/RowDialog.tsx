import type { AdminModelPrice, PriceProvider } from "@portikus/contracts";
import { Button, Dialog, DialogRoot, Select, TextField, useToast } from "@portikus/ui";
import { type FormEvent, useState } from "react";
import { errorText } from "../../api/request.js";
import { TextAreaField } from "../TextAreaField.js";
import { useSaveRow } from "./queries.js";
import {
	type DraftField,
	draftOf,
	PROVIDER_LABEL,
	parseDraft,
	type RowDraft,
} from "./text.js";

const PROVIDER_OPTIONS = (Object.keys(PROVIDER_LABEL) as PriceProvider[]).map((p) => ({
	value: p,
	label: PROVIDER_LABEL[p],
}));

const fieldId = (field: DraftField) => `price-row-${field}`;

/** Add or edit one model's price row by hand (SPEC.md section 10.8). */
export function RowDialog({
	row,
	onClose,
	returnFocusTo,
}: {
	row: AdminModelPrice | null;
	onClose: () => void;
	returnFocusTo: () => HTMLElement | null;
}) {
	const save = useSaveRow();
	const toast = useToast();
	const [draft, setDraft] = useState<RowDraft>(() => draftOf(row));
	const [errors, setErrors] = useState<Partial<Record<DraftField, string>>>({});
	const set = (field: DraftField) => (value: string) =>
		setDraft((d) => ({ ...d, [field]: value }));

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		const parsed = parseDraft(draft);
		if ("errors" in parsed) {
			setErrors(parsed.errors);
			const first = (Object.keys(draft) as DraftField[]).find((f) => parsed.errors[f]);
			if (first) document.getElementById(fieldId(first))?.focus();
			return;
		}
		setErrors({});
		save.mutate(
			{ id: row?.id ?? null, row: parsed.row },
			{
				onSuccess: () => {
					toast.show({
						tone: "success",
						title: row ? "Price row saved" : `${parsed.row.model} added`,
					});
					onClose();
				},
			},
		);
	}

	const text = (
		field: DraftField,
		label: string,
		extra: { hint?: string; unit?: string; mono?: boolean } = {},
	) => (
		<TextField
			id={fieldId(field)}
			label={label}
			value={draft[field]}
			error={errors[field]}
			inputMode={field === "model" || field === "sourceUrl" ? undefined : "decimal"}
			autoComplete="off"
			spellCheck={false}
			onChange={(e) => set(field)(e.target.value)}
			{...extra}
		/>
	);

	return (
		<DialogRoot open onOpenChange={(open) => (open ? null : onClose())}>
			<Dialog
				testId="price-row-dialog"
				returnFocusTo={returnFocusTo}
				title={row ? `Edit ${row.model}` : "Add a price row"}
				description="Ratios are multiples of the model's input price, as the provider's pricing page gives them."
				footer={
					<>
						<Button onClick={onClose}>Cancel</Button>
						<Button
							type="submit"
							form="price-row-form"
							variant="primary"
							data-testid="price-row-save"
							loading={save.isPending}
						>
							{row ? "Save row" : "Add row"}
						</Button>
					</>
				}
			>
				<form id="price-row-form" className="grid gap-4" noValidate onSubmit={onSubmit}>
					<Select
						id={fieldId("provider")}
						label="Provider"
						options={PROVIDER_OPTIONS}
						value={draft.provider}
						onValueChange={set("provider")}
					/>
					{text("model", "Model", {
						mono: true,
						hint: "Matched as part of the model id, so opus-5-5 covers claude-opus-5-5.",
					})}
					{text("inputPricePerMillion", "Input price per million tokens", {
						unit: "USD",
					})}
					{text("outputPricePerMillion", "Output price per million tokens", {
						unit: "USD",
					})}
					<div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))]">
						{text("cacheReadRatio", "Cache read ratio", { hint: "Such as 0.1." })}
						{text("cacheWriteRatio", "Cache write ratio", { hint: "Such as 1.25." })}
						{text("cacheWriteOneHourRatio", "One-hour cache write ratio (optional)")}
						{text("cacheTtlSeconds", "Cache lifetime", { unit: "seconds" })}
					</div>
					<fieldset className="m-0 grid min-w-0 gap-3 border-0 p-0">
						<legend className="pk-label mb-1 p-0 text-[14px] font-medium">
							Long-context surcharge (optional)
						</legend>
						<div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))]">
							{text("surchargeAboveTokens", "Above", { unit: "tokens" })}
							{text("surchargeFactor", "Every price times", { hint: "Such as 2." })}
						</div>
					</fieldset>
					{text("sourceUrl", "Source page", { mono: true })}
					<TextAreaField
						id={fieldId("sourceQuote")}
						label="Quote from the source"
						hint="The sentence or table cell the figures come from."
						rows={3}
						value={draft.sourceQuote}
						error={errors.sourceQuote}
						onChange={set("sourceQuote")}
					/>
					{save.isError ? (
						<p
							className="m-0 text-[13px] text-status-error"
							role="alert"
							data-testid="price-row-error"
						>
							{errorText(save.error)}
						</p>
					) : null}
				</form>
			</Dialog>
		</DialogRoot>
	);
}
