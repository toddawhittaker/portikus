import { MeSettings, Workspace } from "@portikus/contracts";
import { Button, Select } from "@portikus/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { request } from "../api/request.js";
import { DialogError } from "../common/DialogError.js";
import { editorSettingsKey } from "../editor/settingsQueries.js";

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

/** From this far ahead the end also names its date, so a week-long hold is not read as today. */
const DATED_FROM_MS = 6 * 24 * 3_600_000;

/**
 * A hold's end as "Thu 11:30 PM", or "Thu, Oct 8, 11:30 PM" when six days or
 * more ahead, in the student's timezone setting when one is known and valid,
 * else the browser's.
 */
export function formatHoldEnd(
	iso: string,
	timeZone?: string,
	now = Date.now(),
): string {
	const options: Intl.DateTimeFormatOptions = {
		weekday: "short",
		hour: "numeric",
		minute: "2-digit",
		...(Date.parse(iso) - now >= DATED_FROM_MS
			? { month: "short", day: "numeric" }
			: {}),
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
	const [said, setSaid] = useState("");
	const statusRef = useRef<HTMLSpanElement>(null);
	const setRef = useRef<HTMLButtonElement>(null);
	const active = holdActive(workspace);
	// Kept outside the section, which goes away when a hold ends under a cap of 0.
	const showSection = choices.length > 0 || active;
	const status = (
		<span
			role="status"
			className="sr-only"
			data-testid="keep-running-announce"
			ref={statusRef}
		>
			{said}
		</span>
	);
	const fallback = choices.includes(PREFERRED_HOURS)
		? PREFERRED_HOURS
		: (choices[choices.length - 1] ?? 1);
	const hours = picked !== null && choices.includes(picked) ? picked : fallback;
	const endFor = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

	const until = endFor(hours);

	function hold(next: string) {
		// Cleared first, so the same words twice in a row are still announced.
		setSaid("");
		keep.mutate(next, {
			onSuccess: (saved) =>
				setSaid(
					`Kept running until ${formatHoldEnd(saved.keepRunningUntil ?? next, timeZone)}.`,
				),
		});
	}

	function release() {
		setSaid("");
		keep.mutate(null, {
			onSuccess: () => {
				setSaid("Keep running ended.");
				// The pressed button is gone; with no choices, the dialog heading keeps the place.
				const dialog = statusRef.current?.closest('[role="dialog"]');
				const heading = dialog?.getAttribute("aria-labelledby");
				const target =
					setRef.current ?? (heading ? document.getElementById(heading) : null);
				target?.focus();
			},
		});
	}

	return (
		<>
			{showSection ? (
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
						<p className="pk-text-compact m-0 text-ink-muted">
							Your workspace stays on until the time you pick, even if you close this
							page or leave it idle. Then it stops as usual, with a warning first.
						</p>
					)}
					<form
						className="flex flex-wrap items-end gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							// Measured from the click, not from when the dialog opened.
							if (!keep.isPending && choices.length > 0) hold(endFor(hours));
						}}
					>
						{choices.length > 0 ? (
							<>
								<Select
									id="keep-running-hours"
									label="Keep running for"
									options={choices.map((h) => ({
										value: String(h),
										label: hoursText(h),
									}))}
									value={String(hours)}
									onValueChange={(value) => setPicked(Number(value))}
								/>
								<Button
									type="submit"
									variant="primary"
									data-testid="keep-running-set"
									ref={setRef}
									// The end time can outgrow a narrow dialog or 200% text, so it wraps.
									className="h-auto! min-h-[var(--pk-control)] whitespace-normal! py-1.5 text-left leading-snug!"
									loading={keep.isPending && keep.variables !== null}
								>
									Keep running until {formatHoldEnd(until, timeZone)}
								</Button>
							</>
						) : null}
						{active ? (
							<Button
								data-testid="keep-running-end"
								loading={keep.isPending && keep.variables === null}
								onClick={() => !keep.isPending && release()}
							>
								Don't keep running
							</Button>
						) : null}
					</form>
					<DialogError error={keep.error} />
				</section>
			) : null}
			{status}
		</>
	);
}
