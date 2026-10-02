import {
	countIncusCpus,
	type HealthReport,
	type UpdateLimitsRequest,
	type WorkspaceLimits,
} from "@portikus/contracts";
import { Button, Dialog, DialogRoot } from "@portikus/ui";
import { useState } from "react";
import { DraftFields } from "./DraftFields.js";

/** The terminals unit's own TasksMax, which a higher process limit does not raise (SPEC.md section 19.3). */
const TERMINALS_TASKS_MAX = 1700;

export type LimitKey = keyof UpdateLimitsRequest;

const LIMIT_FIELDS: {
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

/** The shared profile's limits in the dialog's units; null where unset or unreadable. */
export type SiteLimits = Record<LimitKey, number | null>;

const BYTES_PER_UNIT: Record<string, number> = {
	"": 1,
	B: 1,
	kB: 1e3,
	KB: 1e3,
	KiB: 1024,
	MB: 1e6,
	MiB: 1024 ** 2,
	GB: 1e9,
	GiB: 1024 ** 3,
	TB: 1e12,
	TiB: 1024 ** 4,
};

/** Incus's `limits.memory` ("4GB", "4096MiB") in MiB; null for a percentage or nonsense. */
export function incusMemoryMiB(value: string | null): number | null {
	const match = /^(\d+(?:\.\d+)?)\s*([A-Za-z]*)$/.exec(value?.trim() ?? "");
	const unit = match ? BYTES_PER_UNIT[match[2] ?? ""] : undefined;
	if (!match || unit === undefined) return null;
	return Math.round((Number(match[1]) * unit) / 1024 ** 2);
}

/** The site values a blank field falls back to, from the Health report's host sample. */
export function siteLimits(host: HealthReport["host"] | undefined): SiteLimits | null {
	if (!host) return null;
	const { cpu, memory, processes } = host.profileLimits;
	return {
		cpu: countIncusCpus(cpu),
		memoryMiB: incusMemoryMiB(memory),
		processes: processes && /^\d+$/.test(processes.trim()) ? Number(processes) : null,
	};
}

const count = (n: number) => n.toLocaleString("en-US");

/** "4 GiB" or "3.7 GiB" from MiB, one decimal at most. */
function gibText(mib: number): string {
	return `${count(Math.round((mib / 1024) * 10) / 10)} GiB`;
}

/** "4,096 MiB (4 GiB)"; below a GiB, MiB alone. */
export function memoryText(mib: number): string {
	return mib < 1024 ? `${count(mib)} MiB` : `${count(mib)} MiB (${gibText(mib)})`;
}

/** One limit as a phrase: "2 CPUs", "4 GiB memory", "2,000 processes". */
export function limitPhrase(key: LimitKey, value: number): string {
	if (key === "cpu") return `${count(value)} ${value === 1 ? "CPU" : "CPUs"}`;
	if (key === "memoryMiB") return `${gibText(value)} memory`;
	return `${count(value)} processes`;
}

function siteHint(key: LimitKey, site: SiteLimits | null): string | null {
	const value = site?.[key] ?? null;
	if (value === null) return null;
	return `Site value: ${key === "memoryMiB" ? memoryText(value) : count(value)}.`;
}

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
	site,
	pending,
	serverError,
	onSave,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	current: WorkspaceLimits | null;
	ownerName: string;
	/** What a blank field falls back to, once the Health report has loaded. */
	site: SiteLimits | null;
	pending: boolean;
	serverError: string | null;
	onSave: (body: UpdateLimitsRequest) => void;
}) {
	const [drafts, setDrafts] = useState<LimitDrafts>(() => limitDrafts(current));
	const [errors, setErrors] = useState<Partial<Record<LimitKey, string>>>({});

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
				title={`Limits for ${ownerName}'s workspace`}
				description="The most CPU, memory and processes this workspace may use. Leave a field blank to use the site value."
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
				<DraftFields
					idPrefix="limits"
					fields={LIMIT_FIELDS}
					drafts={drafts}
					setDrafts={setDrafts}
					errors={errors}
					hint={(key) =>
						[siteHint(key, site), LIMIT_FIELDS.find((f) => f.key === key)?.hint]
							.filter(Boolean)
							.join(" ")
					}
					// Only the input is narrow; the label and hint use the dialog's width.
					fieldClassName="[&>input]:w-40"
					layoutClassName="flex flex-col gap-4"
					serverError={serverError}
				/>
			</Dialog>
		</DialogRoot>
	);
}
