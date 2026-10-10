import type { AgentUsageWindow } from "@portikus/contracts";
import { useState } from "react";
import { UsagePeriodSelect, UsageTables } from "../admin/agent-usage/UsageTables.js";
import { ApiError } from "../api/request.js";
import { useCourseAgentUsage } from "./queries.js";

/** Coding-agent totals for the course's members; counts only, never prompts or code (SPEC.md section 25.10). */
export function CourseUsage({ courseId }: { courseId: string }) {
	const [days, setDays] = useState<AgentUsageWindow>(7);
	const usage = useCourseAgentUsage(courseId, days);
	const data = usage.data;
	return (
		<section className="flex flex-col gap-3" aria-labelledby="usage-title">
			<h2 className="pk-text-heading m-0" id="usage-title">
				Agent usage
			</h2>
			<p className="pk-text-body pk-muted m-0 max-w-prose">
				How much each person here has used Claude Code and Codex, including use outside
				this course. Counts never include prompts or code. The agents report them from
				inside the workspace, so treat them as a guide, not proof.
			</p>
			<UsagePeriodSelect
				id="course-usage-days"
				days={days}
				ready={usage.isSuccess && !usage.isPlaceholderData}
				onChange={setDays}
			/>
			{usage.isError ? (
				<p className="pk-error text-status-error m-0" role="alert">
					{usage.error instanceof ApiError
						? usage.error.message
						: "Agent usage could not be loaded."}
				</p>
			) : null}
			{data && data.users.length === 0 ? (
				<p className="pk-text-body pk-muted m-0" data-testid="agent-usage-empty">
					No agent usage was reported for this course in this period.
				</p>
			) : null}
			{data && data.users.length > 0 ? <UsageTables data={data} /> : null}
		</section>
	);
}
