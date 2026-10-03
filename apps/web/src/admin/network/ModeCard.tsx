import type { AdminEgressView, EgressMode } from "@portikus/contracts";
import {
	ConfirmDialog,
	ConfirmDialogRoot,
	Icon,
	Toggletip,
	useToast,
} from "@portikus/ui";
import { useEffect, useState } from "react";
import { joinWords, plural } from "../../text.js";
import { AdminGroup } from "../AdminSection.js";
import { egressErrorText, useEgressWrite } from "./queries.js";
import { applyAnnouncement, applyState, listedHostCount } from "./text.js";

const MODE_TEXT: Record<EgressMode, { name: string; summary: string }> = {
	open: {
		name: "Open",
		summary:
			"Workspaces can reach any public site except your blocked sites. Private networks stay blocked, as always.",
	},
	"allow-list": {
		name: "Allow-list",
		summary:
			"Workspaces can reach only the presets, host names and ranges below. Everything else fails.",
	},
};

/** The dialog's plain statement of what switching changes for students. */
function switchText(view: AdminEgressView, to: EgressMode): string {
	if (to === "open") {
		return "Workspaces will reach any public site again, except your blocked sites. Private networks stay blocked. Your presets and list are kept for next time.";
	}
	const hosts = listedHostCount(view);
	const ranges = view.entries.filter((entry) => entry.kind === "range").length;
	const listed =
		hosts + ranges === 0
			? "Nothing is listed yet, so workspaces will reach no site at all."
			: `Workspaces will reach only the ${plural(hosts, "host")} and ${plural(ranges, "range")} listed, on ports ${joinWords(view.ports.map(String))}.`;
	return `${listed} Everything else fails with "Could not resolve host". Connections to anything else stop now, including downloads in progress.`;
}

/** The mode switch and whether the workspaces follow the saved policy yet. */
export function ModeCard({ view }: { view: AdminEgressView }) {
	const write = useEgressWrite();
	const toast = useToast();
	const [target, setTarget] = useState<EgressMode | null>(null);
	const [now, setNow] = useState(() => Date.now());
	// "Applied just now" ages without a refetch.
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, []);
	const status = applyState(view, now);

	function confirm() {
		if (!target) return;
		write.mutate(
			{ kind: "mode", version: view.version, mode: target },
			{
				onSuccess: () => {
					toast.show({
						tone: "success",
						title: `${MODE_TEXT[target].name} mode saved`,
					});
					setTarget(null);
				},
			},
		);
	}

	return (
		<AdminGroup
			id="egress-mode-title"
			title="Internet access from workspaces"
			testId="egress-mode-card"
			help={
				<Toggletip label="open and allow-list modes">
					Open lets workspaces reach any public site except the ones you block.
					Allow-list lets them reach only the presets, hosts and ranges you list.
					Private networks are always blocked.
				</Toggletip>
			}
			description={
				status.tone === "applied"
					? MODE_TEXT[view.mode].summary
					: `Saved setting: ${MODE_TEXT[view.mode].summary}`
			}
			actions={
				<fieldset
					aria-labelledby="egress-mode-title"
					className="pk-segmented text-[13px]"
					data-testid="egress-mode"
				>
					{(["open", "allow-list"] as const).map((mode) => (
						<button
							key={mode}
							type="button"
							className="px-4! py-1.5!"
							aria-pressed={view.mode === mode}
							data-testid={`egress-mode-${mode}`}
							onClick={() => {
								if (view.mode !== mode) setTarget(mode);
							}}
						>
							{MODE_TEXT[mode].name}
						</button>
					))}
				</fieldset>
			}
		>
			{/* Only a state that needs attention gets a coloured fill. */}
			<p
				className={`m-0 flex items-start gap-2 text-[13px] ${
					status.tone === "error"
						? "rounded-sm bg-status-error-soft px-3 py-2 text-ink"
						: status.tone === "pending"
							? "rounded-sm bg-status-starting-soft px-3 py-2 text-ink"
							: "text-ink-muted"
				}`}
				data-testid="egress-apply-status"
				data-tone={status.tone}
			>
				<span
					className={`mt-0.5 flex-none ${status.tone === "error" ? "text-status-error" : ""}`}
				>
					{status.tone === "pending" ? (
						<span className="pk-spin" aria-hidden={true} />
					) : (
						<Icon
							name={
								status.tone === "error"
									? "alert"
									: status.tone === "applied"
										? "check"
										: "info"
							}
							size="sm"
						/>
					)}
				</span>
				<span className="min-w-0">{status.text}</span>
				<span className="-my-1 flex-none">
					<Toggletip label="apply status">
						Saved changes reach the workspaces within seconds. Applied means every
						running workspace follows the saved setting.
					</Toggletip>
				</span>
			</p>
			{/* Announces state changes only; the visible age text ticks every 30 seconds. */}
			<p className="sr-only" role="status" data-testid="egress-apply-announce">
				{applyAnnouncement(status)}
			</p>
			<ConfirmDialogRoot
				open={target !== null}
				onOpenChange={(open) => {
					if (!open) {
						setTarget(null);
						write.reset();
					}
				}}
			>
				{target ? (
					<ConfirmDialog
						id="egress-mode-confirm"
						testId="egress-mode-dialog"
						title={
							target === "open" ? "Switch to open mode?" : "Switch to allow-list mode?"
						}
						description={switchText(view, target)}
						confirmLabel={target === "open" ? "Switch to open" : "Switch to allow-list"}
						destructive={target === "allow-list"}
						pending={write.isPending}
						onConfirm={confirm}
					>
						{write.isError ? (
							<p className="m-0 text-[13px] text-status-error" role="alert">
								{egressErrorText(write.error)}
							</p>
						) : null}
					</ConfirmDialog>
				) : null}
			</ConfirmDialogRoot>
		</AdminGroup>
	);
}
