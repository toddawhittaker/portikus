import { MeSettings, Workspace } from "@portikus/contracts";
import { Button, Select } from "@portikus/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { request } from "../api/request.js";
import { editorSettingsKey } from "../editor/settingsQueries.js";
import { DialogError } from "../projects/DialogError.js";

/** The lengths a student can pick, in hours; only those within the cap are offered. */
const STEPS = [1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168];

/** Picked first: long enough for an overnight run. */
const PREFERRED_HOURS = 8;

/** The hours a student may choose under `maxHours`, always ending with the cap. */
export function keepRunningChoices(maxHours: number): number[] {
	if (maxHours <= 0) return [];
	const choices = STEPS.filter((hours) => hours < maxHours);
	return [...choices, maxHours];
}

function hoursText(hours: number): string {
	return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/**
 * A hold's end as "Thu 11:30 PM", in the student's timezone setting when one
 * is known and valid, else the browser's.
 */
export function formatHoldEnd(iso: string, timeZone?: string): string {
	const options: Intl.DateTimeFormatOptions = {
		weekday: "short",
		hour: "numeric",
		minute: "2-digit",
	};
	try {
		return new Date(iso).toLocaleString(undefined, { ...options, timeZone });
	} catch {
		return new Date(iso).toLocaleString(undefined, options);
	}
}

/** Whether the workspace has a hold that has not yet ended. */
export function holdActive(
	workspace: Pick<Workspace, "keepRunningUntil"> | null,
	now = Date.now(),
): boolean {
	if (!workspace?.keepRunningUntil) return false;
	return Date.parse(workspace.keepRunningUntil) > now;
}

/**
 * The student's timezone setting, read from the settings the workspace page
 * already loads; never fetched from here.
 */
export function useStudentTimezone(): string | undefined {
	return useQuery({
		queryKey: editorSettingsKey,
		queryFn: () => request(MeSettings, "/me/settings"),
		enabled: false,
	}).data?.timezone;
}

function useKeepRunning(workspaceId: string) {
	return useMutation({
		mutationFn: (until: string | null) =>
			request(Workspace, `/workspaces/${workspaceId}/keep-running`, {
				method: until ? "PUT" : "DELETE",
				...(until
					? {
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ until }),
						}
					: {}),
			}),
	});
}

/**
 * "Keep running" in the workspace dialog (#955): hold the workspace up for a
 * while, so leaving and idle time do not stop it, then end the hold early.
 * The new hold reaches the page over the workspace socket.
 */
export function KeepRunningSection({
	workspaceId,
	workspace,
}: {
	workspaceId: string;
	workspace: Workspace;
}) {
	const choices = keepRunningChoices(workspace.keepRunningMaxHours);
	const [picked, setPicked] = useState<number | null>(null);
	const timeZone = useStudentTimezone();
	const keep = useKeepRunning(workspaceId);
	const active = holdActive(workspace);
	if (choices.length === 0 && !active) return null;

	const fallback = choices.includes(PREFERRED_HOURS)
		? PREFERRED_HOURS
		: (choices[choices.length - 1] ?? 1);
	const hours = picked !== null && choices.includes(picked) ? picked : fallback;
	const endFor = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

	return (
		<section
			className="flex flex-col items-start gap-2"
			aria-labelledby="workspace-keep-running-title"
		>
			<h3 id="workspace-keep-running-title" className="pk-text-heading m-0">
				Keep running
			</h3>
			{active && workspace.keepRunningUntil ? (
				<p className="pk-text-body m-0" data-testid="keep-running-status">
					Kept running until{" "}
					<strong>{formatHoldEnd(workspace.keepRunningUntil, timeZone)}</strong>.
					Closing this page or leaving it idle does not stop it before then.
				</p>
			) : (
				<p className="pk-text-small m-0 text-ink-muted">
					Keep your workspace on while you are away, for example while an agent works
					overnight. Closing this page or leaving it idle does not stop it until the
					time you pick. Afterwards it stops as usual, with a warning first.
				</p>
			)}
			{choices.length > 0 ? (
				<div className="flex flex-wrap items-end gap-2">
					<Select
						id="keep-running-hours"
						label={active ? "Change to" : "Keep running for"}
						options={choices.map((h) => ({ value: String(h), label: hoursText(h) }))}
						value={String(hours)}
						hint={`Until ${formatHoldEnd(endFor(hours), timeZone)}`}
						onValueChange={(value) => setPicked(Number(value))}
					/>
					<Button
						variant="primary"
						data-testid="keep-running-set"
						loading={keep.isPending && keep.variables !== null}
						onClick={() => !keep.isPending && keep.mutate(endFor(hours))}
					>
						{active ? "Change" : "Keep running"}
					</Button>
				</div>
			) : null}
			{active ? (
				<Button
					data-testid="keep-running-end"
					loading={keep.isPending && keep.variables === null}
					onClick={() => !keep.isPending && keep.mutate(null)}
				>
					End hold
				</Button>
			) : null}
			<DialogError error={keep.error} />
		</section>
	);
}
