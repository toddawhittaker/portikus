import type { AiSettingsView } from "@portikus/contracts";
import { Skeleton, useToast } from "@portikus/ui";
import { errorText } from "../../api/request.js";
import { AdminSection, AdminGroup as Group } from "../AdminSection.js";
import { LimitsGroup } from "./LimitsGroup.js";
import { NoticeGroup } from "./NoticeGroup.js";
import { ProviderGroup } from "./ProviderGroup.js";
import { useAiSettings, useUpdateAi } from "./queries.js";
import { TestGroup } from "./TestGroup.js";
import { switchBlocked } from "./text.js";

const TITLE = "AI";

const INTRO = {
	id: "admin-ai",
	helpAnchor: "admin-ai",
	lead: "Connect the built-in assistant to a hosted model.",
	text: "Read the privacy notice, set the provider and its key, test it, then turn the assistant on. Only administrators can use it.",
};

/** The built-in AI settings tab (SPEC.md section 20.4, issue #2068 F2). */
export function AiTab() {
	const settings = useAiSettings();
	if (settings.isError) {
		return (
			<AdminSection title={TITLE} intro={INTRO} measure="form">
				<p className="m-0 text-status-error" role="alert">
					{errorText(settings.error)}
				</p>
			</AdminSection>
		);
	}
	if (!settings.data) {
		return (
			<AdminSection title={TITLE} intro={INTRO} measure="form">
				<div className="grid gap-6" aria-busy="true" data-testid="ai-loading">
					<Skeleton variant="block" height={220} />
					<Skeleton variant="block" height={320} />
				</div>
			</AdminSection>
		);
	}
	const view = settings.data;
	return (
		<AdminSection title={TITLE} intro={INTRO} measure="form">
			<NoticeGroup view={view} />
			{/* Keyed by the saved provider, so a save elsewhere resets the drafts. */}
			<ProviderGroup
				key={`${view.providerKind} ${view.baseUrl} ${view.model}`}
				view={view}
			/>
			<LimitsGroup
				key={`${view.monthlyTokenCap} ${view.conversationTokenBudget}`}
				view={view}
			/>
			<TestGroup />
			<SwitchGroup view={view} />
		</AdminSection>
	);
}

const REASON = "ai-switch-reason";

function SwitchGroup({ view }: { view: AiSettingsView }) {
	const toast = useToast();
	const save = useUpdateAi();
	const blocked = switchBlocked(view);
	// Turning off always works, so a site can stop the assistant at once.
	const locked = blocked !== null && !view.enabled;
	const on = save.isPending ? (save.variables?.enabled ?? view.enabled) : view.enabled;

	function toggle(next: boolean) {
		if (save.isPending || (locked && next)) return;
		save.mutate(
			{ enabled: next },
			{
				onSuccess: () =>
					toast.show({
						tone: "success",
						title: next ? "Assistant turned on" : "Assistant turned off",
					}),
			},
		);
	}

	return (
		<Group id="ai-switch-title" title="Assistant" testId="ai-switch-group">
			<div className="grid gap-1">
				<label
					className={`pk-switch text-[14px] ${locked ? "cursor-not-allowed text-ink-muted" : ""}`}
				>
					<input
						type="checkbox"
						role="switch"
						aria-checked={on}
						data-testid="ai-switch"
						checked={on}
						aria-disabled={locked || save.isPending || undefined}
						aria-describedby={REASON}
						onChange={(event) => toggle(event.target.checked)}
					/>
					<span>Turn on the assistant for administrators</span>
				</label>
				<p
					id={REASON}
					className="pk-muted m-0 text-[13px]"
					data-testid="ai-switch-reason"
				>
					{locked
						? blocked
						: on
							? "Administrators see the Assistant button in the header."
							: "When on, administrators see the Assistant button in the header."}
				</p>
				{save.isError ? (
					<p className="m-0 text-[13px] text-status-error" role="alert">
						{errorText(save.error)}
					</p>
				) : null}
			</div>
		</Group>
	);
}
