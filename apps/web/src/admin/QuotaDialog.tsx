import {
	isQuotaGrowOnly,
	MAX_QUOTA_GIB,
	QUOTA_SHRINK_MESSAGE,
	type QuotaConfig,
} from "@portikus/contracts";
import { Button, Dialog, DialogRoot, TextField } from "@portikus/ui";
import { useState } from "react";
import { announced } from "./SettingsTab.js";

export interface QuotaProblem {
	message: string;
	/** Whether the message is about this field. */
	home: boolean;
	docker: boolean;
}

/** The problem with a draft and the fields it is about, or null when it can be sent (Epic 11 brief, "storage can only grow"). */
export function quotaError(
	from: QuotaConfig,
	home: string,
	docker: string,
): QuotaProblem | null {
	const [homeText, dockerText] = [home.trim(), docker.trim()];
	const whole = (value: string) => /^\d+$/.test(value);
	if (!whole(homeText) || !whole(dockerText)) {
		return {
			message: "Enter whole numbers of GiB.",
			home: !whole(homeText),
			docker: !whole(dockerText),
		};
	}
	const to = { homeGiB: Number(homeText), dockerGiB: Number(dockerText) };
	if (to.homeGiB > MAX_QUOTA_GIB || to.dockerGiB > MAX_QUOTA_GIB) {
		return {
			message: `Each size can be at most ${MAX_QUOTA_GIB} GiB.`,
			home: to.homeGiB > MAX_QUOTA_GIB,
			docker: to.dockerGiB > MAX_QUOTA_GIB,
		};
	}
	if (!isQuotaGrowOnly(from, to)) {
		return {
			message: QUOTA_SHRINK_MESSAGE,
			home: to.homeGiB < from.homeGiB,
			docker: to.dockerGiB < from.dockerGiB,
		};
	}
	if (to.homeGiB === from.homeGiB && to.dockerGiB === from.dockerGiB) {
		// No single culprit, so it points at Home.
		return { message: "Change at least one size.", home: true, docker: false };
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
	const [problem, setProblem] = useState<QuotaProblem | null>(null);
	const error = problem?.message ?? null;

	function save() {
		const found = quotaError(current, home, docker);
		setProblem(found);
		if (found) return;
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
						error={problem?.home ? announced(error) : undefined}
						value={home}
						onChange={(event) => setHome(event.target.value)}
					/>
					<TextField
						id="quota-docker"
						label="Docker (GiB)"
						inputMode="numeric"
						className="w-32"
						data-testid="quota-docker"
						// Announced once: only here when Home is not also at fault.
						error={
							problem?.docker ? (problem.home ? error : announced(error)) : undefined
						}
						value={docker}
						onChange={(event) => setDocker(event.target.value)}
					/>
				</div>
				{!error && serverError ? (
					<p className="m-0 mt-3 text-[13px] text-status-error" role="alert">
						{serverError}
					</p>
				) : null}
			</Dialog>
		</DialogRoot>
	);
}
