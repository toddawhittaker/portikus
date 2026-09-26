import type {
	EffectiveGuard,
	GuardConfig,
	UpdateGuardRequest,
} from "@portikus/contracts";
import { Button, Dialog, DialogRoot, TextField } from "@portikus/ui";
import { useState } from "react";
import { GUARD_FIELDS, type GuardKey, parseGuardValue } from "./guardFields.js";
import { announced } from "./SettingsTab.js";

export type { GuardKey } from "./guardFields.js";

export type GuardDrafts = Record<GuardKey, string>;

/**
 * The request body for the drafts, or the errors by field. A blank field
 * removes that override, so the workspace uses the platform value.
 */
export function guardRequest(
	drafts: GuardDrafts,
): { body: UpdateGuardRequest } | { errors: Partial<Record<GuardKey, string>> } {
	const body: Record<string, number | null> = {};
	const errors: Partial<Record<GuardKey, string>> = {};
	for (const field of GUARD_FIELDS) {
		const text = drafts[field.key].trim();
		if (text === "") {
			body[field.key] = null;
			continue;
		}
		const value = parseGuardValue(field.key, text);
		if (value === null) errors[field.key] = field.rangeText;
		else body[field.key] = value;
	}
	if (Object.keys(errors).length > 0) return { errors };
	return { body: body as UpdateGuardRequest };
}

/** The drafts a dialog opens with: each override, blank where there is none. */
export function guardDrafts(config: GuardConfig | null): GuardDrafts {
	const drafts = {} as GuardDrafts;
	for (const field of GUARD_FIELDS) {
		const value = config?.[field.key];
		drafts[field.key] = value === undefined ? "" : String(value);
	}
	return drafts;
}

/** Override the resource guard for one workspace (ADR 0032). */
export function GuardDialog({
	open,
	onOpenChange,
	current,
	defaults,
	ownerName,
	pending,
	serverError,
	onSave,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	current: GuardConfig | null;
	/** The platform values a blank field falls back to, once loaded. */
	defaults: EffectiveGuard | null;
	ownerName: string;
	pending: boolean;
	serverError: string | null;
	onSave: (body: UpdateGuardRequest) => void;
}) {
	const [drafts, setDrafts] = useState<GuardDrafts>(() => guardDrafts(current));
	const [errors, setErrors] = useState<Partial<Record<GuardKey, string>>>({});
	const firstError = GUARD_FIELDS.find((field) => errors[field.key])?.key;

	function save() {
		const result = guardRequest(drafts);
		if ("errors" in result) {
			setErrors(result.errors);
			return;
		}
		setErrors({});
		onSave(result.body);
	}

	return (
		<DialogRoot open={open} onOpenChange={onOpenChange}>
			<Dialog
				testId="guard-dialog"
				title="Resource guard overrides"
				description={`Limits for ${ownerName}'s workspace. Leave a field blank to use the platform value. Changes apply within a minute.`}
				footer={
					<>
						<Button onClick={() => onOpenChange(false)}>Cancel</Button>
						<Button
							variant="primary"
							data-testid="guard-save"
							loading={pending}
							onClick={save}
						>
							Save
						</Button>
					</>
				}
			>
				<div className="grid grid-cols-2 gap-4">
					{GUARD_FIELDS.map((field) => {
						const error = errors[field.key] ?? null;
						return (
							<TextField
								key={field.key}
								id={`guard-${field.key}`}
								label={field.label}
								inputMode="numeric"
								data-testid={`guard-${field.key}`}
								hint={defaults ? `Platform value: ${defaults[field.key]}` : undefined}
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
					<p className="m-0 mt-3 text-[13px] text-status-error" role="alert">
						{serverError}
					</p>
				) : null}
			</Dialog>
		</DialogRoot>
	);
}
