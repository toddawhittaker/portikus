import type { AgentUsageWindow } from "@portikus/contracts";
import { useState } from "react";
import { ApiError } from "../../api/request.js";
import { AdminSection } from "../AdminSection.js";
import { useAgentUsage } from "./queries.js";
import { UsagePeriodSelect, UsageTables } from "./UsageTables.js";

/** The Agent usage tab of the admin page (SPEC.md section 25.10): everyone's totals, counts only. */
export function AgentUsageTab() {
	const [days, setDays] = useState<AgentUsageWindow>(7);
	const usage = useAgentUsage(days);
	const data = usage.data;
	return (
		<AdminSection
			title="Agent usage"
			intro={{
				id: "admin-agents",
				text: "How much each person has used Claude Code and Codex. Usage counts never include prompts or code. The agents report them from inside the workspace, so treat them as a guide, not proof.",
				helpAnchor: "admin-agents",
			}}
		>
			<UsagePeriodSelect
				id="agent-usage-days"
				days={days}
				ready={usage.isSuccess && !usage.isPlaceholderData}
				onChange={setDays}
			/>
			{usage.isError ? (
				<p className="pk-error text-status-error" role="alert">
					{usage.error instanceof ApiError
						? usage.error.message
						: "Agent usage could not be loaded."}
				</p>
			) : null}
			{data && data.users.length === 0 ? (
				<p className="pk-text-body pk-muted" data-testid="agent-usage-empty">
					No agent usage was reported in this period.
				</p>
			) : null}
			{data && data.users.length > 0 ? <UsageTables data={data} /> : null}
		</AdminSection>
	);
}
