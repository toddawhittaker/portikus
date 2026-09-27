import type { UpdateLimitsRequest, WorkspaceLimits } from "@portikus/contracts";
import { Button, Dialog, DialogRoot, TextField } from "@portikus/ui";
import { useState } from "react";
import { announced } from "./SettingsTab.js";

/** The terminals unit's own TasksMax, which a higher process limit does not raise (SPEC.md section 19.3). */
export const TERMINALS_TASKS_MAX = 1700;

export type LimitKey = keyof UpdateLimitsRequest;

export const LIMIT_FIELDS: {
	key: LimitKey;
	label: string;
	min: number;
	max: number;
	hint: string;
}[] = [
	{ key: "cpu", label: "CPUs", min: 1, max: 64, hint: "At most the host's CPU count." },
	{
		key: "memoryMiB",
		label: "Memory (MiB)",
		min: 512,
		max: 262144,
		hint: "Below what the workspace uses now, the kernel stops its largest process.",
	},
	{
		key: "processes",
		label: "Processes",
		min: 500,
		max: 32768,
		hint: `Above ${TERMINALS_TASKS_MAX.toLocaleString("en-US")}, terminals keep their own limit of ${TERMINALS_TASKS_MAX.toLocaleString("en-US")}.`,
	},
];

export type LimitDrafts = Record<LimitKey, string>;

/**
 * The request body for the drafts, or the errors by field. A blank field
 * sends null, so the workspace uses the platform value from the profile.
 */
export function limitsRequest(
	drafts: LimitDrafts,
): { body: UpdateLimitsRequest } | { errors: Partial<Record<LimitKey, string>> } {
	const body = {} as UpdateLimitsRequest;
	const errors: Partial<Record<LimitKey, string>> = {};
	for (const field of LIMIT_FIELDS) {
		const text = drafts[field.key].trim();
		if (text === "") {
			body[field.key] = null;
			continue;
		}
		const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
		if (!(value >= field.min && value <= field.max)) {
			errors[field.key] =
				`Enter a whole number from ${field.min} to ${field.max}, or leave it blank.`;
		} else {
			body[field.key] = value;
		}
	}
	if (Object.keys(errors).length > 0) return { errors };
	return { body };
}

/** The drafts a dialog opens with: each limit, blank where the profile applies. */
export function limitDrafts(config: WorkspaceLimits | null): LimitDrafts {
	return {
		cpu: config?.cpu === undefined ? "" : String(config.cpu),
		memoryMiB: config?.memoryMiB === undefined ? "" : String(config.memoryMiB),
		processes: config?.processes === undefined ? "" : String(config.processes),
	};
}

/** Set one workspace's CPU, memory and process limits (SPEC.md section 20.1). */
export function LimitsDialog({
	open,
	onOpenChange,
	current,
	ownerName,
	pending,
	serverError,
	onSave,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	current: WorkspaceLimits | null;
	ownerName: string;
	pending: boolean;
	serverError: string | null;
	onSave: (body: UpdateLimitsRequest) => void;
}) {
	const [drafts, setDrafts] = useState<LimitDrafts>(() => limitDrafts(current));
	const [errors, setErrors] = useState<Partial<Record<LimitKey, string>>>({});
	const firstError = LIMIT_FIELDS.find((field) => errors[field.key])?.key;

	function save() {
		const result = limitsRequest(drafts);
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
				testId="limits-dialog"
				title="Workspace limits"
				description={`Limits for ${ownerName}'s workspace. Leave a field blank to use the platform value. Changes apply to a running workspace within a minute.`}
				footer={
					<>
						<Button onClick={() => onOpenChange(false)}>Cancel</Button>
						<Button
							variant="primary"
							data-testid="limits-save"
							loading={pending}
							onClick={save}
						>
							Save
						</Button>
					</>
				}
			>
				<div className="flex flex-col gap-4">
					{LIMIT_FIELDS.map((field) => {
						const error = errors[field.key] ?? null;
						return (
							<TextField
								key={field.key}
								id={`limits-${field.key}`}
								label={field.label}
								inputMode="numeric"
								className="w-40"
								data-testid={`limits-${field.key}`}
								hint={field.hint}
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
