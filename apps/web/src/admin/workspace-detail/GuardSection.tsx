import type {
	AdminWorkspaceDetail,
	CpuThrottle,
	EffectiveGuard,
	GuardConfig,
	MemoryFlag,
} from "@portikus/contracts";
import { Button, useToast } from "@portikus/ui";
import { useRef, useState } from "react";
import { errorText } from "../../api/request.js";
import { shortTime } from "../../text.js";
import { GuardDialog } from "../GuardDialog.js";
import { useGuardClear, usePlatformSettings, useUpdateGuard } from "../queries.js";
import { PANEL_HELP, SECTION_HEADING, TipTerm } from "./shared.js";

/** "Throttled since Sep 25, 14:02: …", or "Normal" (ADR 0032). */
export function throttleText(throttle: CpuThrottle | null): string {
	if (!throttle) return "Normal";
	return `Throttled since ${shortTime(throttle.at)}. It averaged ${Math.round(
		throttle.averagePercent,
	)}% over ${throttle.windowMinutes} minutes, above ${throttle.thresholdPercent}%, and now gets ${throttle.sharePercent}% of its CPU.`;
}

export function memoryFlagText(flag: MemoryFlag | null): string {
	if (!flag) return "Normal";
	return `High since ${shortTime(flag.at)}. It averaged ${Math.round(
		flag.averagePercent,
	)}% over ${flag.windowMinutes} minutes, above ${flag.thresholdPercent}%.`;
}

/**
 * The limits this workspace runs with, marking the ones it overrides, and the
 * owner's Keep running hold while it lasts, since it holds idle stop off.
 */
export function effectiveGuardText(
	guard: EffectiveGuard,
	config: GuardConfig | null,
	keepRunningUntil: string | null = null,
	now = Date.now(),
): string[] {
	const mark = (key: keyof EffectiveGuard) =>
		config?.[key] === undefined ? "" : " (override)";
	return [
		`CPU above ${guard.cpuThresholdPercent}%${mark("cpuThresholdPercent")} for ${guard.windowMinutes} minutes${mark("windowMinutes")} is slowed to ${guard.throttleSharePercent}%${mark("throttleSharePercent")}.`,
		`Memory above ${guard.memoryThresholdPercent}%${mark("memoryThresholdPercent")} is flagged.`,
		guard.idleStopMinutes === 0
			? `Never stopped for inactivity${mark("idleStopMinutes")}.`
			: `Stopped after ${guard.idleStopMinutes} minutes without activity${mark("idleStopMinutes")}.`,
		...(keepRunningUntil && Date.parse(keepRunningUntil) > now
			? [`Kept running by its owner until ${shortTime(keepRunningUntil)}.`]
			: []),
	];
}

/** Throttle and memory flag, the guard's values and the last input (ADR 0032, SPEC.md §20.1). */
export function GuardSection({
	detail,
	ownerName,
}: {
	detail: AdminWorkspaceDetail;
	ownerName: string;
}) {
	const { workspace, cpuThrottle, memoryFlag } = detail;
	const toast = useToast();
	const clear = useGuardClear();
	const update = useUpdateGuard();
	const settings = usePlatformSettings();
	const [editing, setEditing] = useState(false);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const site = settings.data
		? {
				cpuThresholdPercent: settings.data.cpuGuardThresholdPercent,
				memoryThresholdPercent: settings.data.memoryGuardThresholdPercent,
				windowMinutes: settings.data.guardWindowMinutes,
				throttleSharePercent: settings.data.cpuThrottleSharePercent,
				idleStopMinutes: settings.data.idleStopMinutes,
				keepRunningMaxHours: settings.data.keepRunningMaxHours,
			}
		: null;

	function run(action: "lift-throttle" | "clear-memory-flag") {
		if (clear.isPending) return;
		clear.mutate(
			{ workspaceId: workspace.id, action },
			{
				onSuccess: () => {
					toast.show({
						tone: "success",
						title:
							action === "lift-throttle" ? "Throttle lifted" : "Memory flag cleared",
					});
					// The button goes with the state, so focus moves to the heading.
					headingRef.current?.focus();
				},
				onError: (error) =>
					toast.show({
						tone: "danger",
						title:
							action === "lift-throttle"
								? "Could not lift the throttle"
								: "Could not clear the memory flag",
						children: errorText(error),
					}),
			},
		);
	}

	return (
		<section aria-labelledby="detail-guard" className="pk-detail-section">
			<h4
				id="detail-guard"
				ref={headingRef}
				tabIndex={-1}
				className={`${SECTION_HEADING} outline-none`}
			>
				Resource guard
			</h4>
			<dl className="pk-dl">
				<TipTerm label="CPU throttle" tip={PANEL_HELP.cpu}>
					CPU
				</TipTerm>
				<dd
					className={cpuThrottle ? "text-status-warning" : undefined}
					data-testid="detail-guard-cpu"
				>
					{throttleText(cpuThrottle)}
				</dd>
				<TipTerm label="High memory" tip={PANEL_HELP.memory}>
					Memory
				</TipTerm>
				<dd
					className={memoryFlag ? "text-status-warning" : undefined}
					data-testid="detail-guard-memory"
				>
					{memoryFlagText(memoryFlag)}
				</dd>
				<TipTerm label="Last input" tip={PANEL_HELP.lastInput}>
					Last input (idle stop)
				</TipTerm>
				<dd data-testid="detail-last-activity">
					{workspace.lastActivityAt ? (
						<time dateTime={workspace.lastActivityAt}>
							{shortTime(workspace.lastActivityAt)}
						</time>
					) : (
						"None recorded"
					)}
				</dd>
			</dl>
			<ul
				className="pk-text-compact m-0 flex list-none flex-col gap-0.5 p-0"
				data-testid="detail-guard-limits"
			>
				{effectiveGuardText(
					detail.effectiveGuard,
					detail.guardConfig,
					workspace.keepRunningUntil,
				).map((line) => (
					<li key={line}>{line}</li>
				))}
			</ul>
			<div className="pk-actions">
				{cpuThrottle ? (
					<Button
						size="sm"
						data-testid="detail-lift-throttle"
						aria-label={`Lift throttle on ${ownerName}'s workspace`}
						loading={clear.isPending && clear.variables?.action === "lift-throttle"}
						onClick={() => run("lift-throttle")}
					>
						Lift throttle
					</Button>
				) : null}
				{memoryFlag ? (
					<Button
						size="sm"
						data-testid="detail-clear-memory-flag"
						aria-label={`Clear memory flag on ${ownerName}'s workspace`}
						loading={clear.isPending && clear.variables?.action === "clear-memory-flag"}
						onClick={() => run("clear-memory-flag")}
					>
						Clear memory flag
					</Button>
				) : null}
				<Button
					size="sm"
					data-testid="detail-guard-edit"
					aria-label={`Guard settings for ${ownerName}'s workspace`}
					onClick={() => setEditing(true)}
				>
					Guard settings…
				</Button>
			</div>
			{editing ? (
				<GuardDialog
					open
					onOpenChange={(open) => {
						if (!open) {
							update.reset();
							setEditing(false);
						}
					}}
					current={detail.guardConfig}
					defaults={site}
					ownerName={ownerName}
					pending={update.isPending}
					serverError={update.error ? errorText(update.error) : null}
					onSave={(body) =>
						update.mutate(
							{ workspaceId: workspace.id, body },
							{
								onSuccess: () => {
									toast.show({ tone: "success", title: "Guard settings saved" });
									setEditing(false);
								},
							},
						)
					}
				/>
			) : null}
		</section>
	);
}
