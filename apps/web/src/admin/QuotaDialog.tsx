import {
	isQuotaGrowOnly,
	MAX_QUOTA_GIB,
	QUOTA_SHRINK_MESSAGE,
	type QuotaConfig,
} from "@portikus/contracts";
import { Button, Dialog, DialogRoot, TextField } from "@portikus/ui";
import { useState } from "react";

/** The error for a draft, or null when it can be sent (Epic 11 brief, "storage can only grow"). */
export function quotaError(
	from: QuotaConfig,
	home: string,
	docker: string,
): string | null {
	const values = [home, docker].map((value) => value.trim());
	if (!values.every((value) => /^\d+$/.test(value))) {
		return "Enter whole numbers of GiB.";
	}
	const to = { homeGiB: Number(values[0]), dockerGiB: Number(values[1]) };
	if (to.homeGiB > MAX_QUOTA_GIB || to.dockerGiB > MAX_QUOTA_GIB) {
		return `Each size can be at most ${MAX_QUOTA_GIB} GiB.`;
	}
	if (!isQuotaGrowOnly(from, to)) return QUOTA_SHRINK_MESSAGE;
	if (to.homeGiB === from.homeGiB && to.dockerGiB === from.dockerGiB) {
		return "Change at least one size.";
	}
	return null;
}

/** Grow a workspace's home and Docker volumes; the worker applies it (SPEC.md §20.1). */
export function QuotaDialog({
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
	current: QuotaConfig;
	ownerName: string;
	pending: boolean;
	serverError: string | null;
	onSave: (quota: QuotaConfig) => void;
}) {
	const [home, setHome] = useState(String(current.homeGiB));
	const [docker, setDocker] = useState(String(current.dockerGiB));
	const [error, setError] = useState<string | null>(null);
	const shown = error ?? serverError;

	function save() {
		const problem = quotaError(current, home, docker);
		setError(problem);
		if (problem) return;
		onSave({ homeGiB: Number(home.trim()), dockerGiB: Number(docker.trim()) });
	}

	return (
		<DialogRoot open={open} onOpenChange={onOpenChange}>
			<Dialog
				testId="quota-dialog"
				title="Change storage"
				description={`Storage for ${ownerName}. Sizes can only grow, up to ${MAX_QUOTA_GIB} GiB each.`}
				footer={
					<>
						<Button onClick={() => onOpenChange(false)}>Cancel</Button>
						<Button
							variant="primary"
							data-testid="quota-save"
							loading={pending}
							onClick={save}
						>
							Save
						</Button>
					</>
				}
			>
				<div className="flex gap-4">
					<TextField
						id="quota-home"
						label="Home (GiB)"
						inputMode="numeric"
						className="w-32"
						data-testid="quota-home"
						value={home}
						onChange={(event) => setHome(event.target.value)}
					/>
					<TextField
						id="quota-docker"
						label="Docker (GiB)"
						inputMode="numeric"
						className="w-32"
						data-testid="quota-docker"
						value={docker}
						onChange={(event) => setDocker(event.target.value)}
					/>
				</div>
				{shown ? (
					<p className="m-0 mt-3 text-[13px] text-status-error" role="alert">
						{shown}
					</p>
				) : null}
			</Dialog>
		</DialogRoot>
	);
}
