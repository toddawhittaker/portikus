import type { AgentUsageWindow, AiPurpose } from "@portikus/contracts";
import { Meter, Toggletip } from "@portikus/ui";
import { ApiError } from "../../api/request.js";
import { AdminGroup } from "../AdminSection.js";
import { count } from "./format.js";
import { useAiUsage } from "./queries.js";
import { LEAD_CELL_CLASS } from "./UsageTables.js";
import "./usage.css";

const PURPOSE_NAME: Record<AiPurpose, string> = {
	assistant: "Assistant",
	pricing: "Price check",
};

const CACHE_HELP =
	"Tokens read from and written to the prompt cache, added together. Cached tokens cost far less than new input.";

const TABLE_CLASS = "pk-table pk-usage-table table-fixed min-w-[52rem]";

/**
 * The built-in assistant's tokens this month against the site's cap, and
 * each person's use over the chosen period (SPEC.md section 20.4). Counts
 * only, never conversation text.
 */
export function AiUsageSection({ days }: { days: AgentUsageWindow }) {
	const usage = useAiUsage(days);
	const data = usage.data;
	return (
		<AdminGroup
			id="ai-usage-title"
			title="Built-in assistant"
			testId="ai-usage"
			description="Tokens the assistant and the weekly price check used. Counts only, never what was said."
		>
			{usage.isError ? (
				<p className="pk-error text-status-error" role="alert">
					{usage.error instanceof ApiError
						? usage.error.message
						: "Assistant usage could not be loaded."}
				</p>
			) : null}
			{data ? (
				<>
					<div className="grid max-w-[36rem] gap-1">
						<span
							id="ai-usage-month-label"
							className="pk-label text-[14px] font-medium"
						>
							Used this month
						</span>
						<Meter
							aria-labelledby="ai-usage-month-label"
							value={data.month.usedTokens}
							max={data.month.capTokens}
							high={data.month.capTokens * 0.9}
							valueText={`${count(data.month.usedTokens)} of ${count(data.month.capTokens)} tokens`}
						/>
					</div>
					{data.users.length === 0 ? (
						<p className="pk-text-body pk-muted" data-testid="ai-usage-empty">
							The assistant was not used in this period.
						</p>
					) : (
						<div className="pk-usage-wrap">
							<div className="pk-table-wrap overflow-x-auto">
								<table className={TABLE_CLASS} data-testid="ai-usage-users">
									<caption className="sr-only">
										Built-in assistant use per person, {data.from} to {data.to}
									</caption>
									<colgroup>
										<col />
										<col className="w-28" />
										<col className="w-44" />
										<col className="w-28" />
										<col className="w-32" />
										<col className="w-36" />
									</colgroup>
									<thead>
										<tr>
											<th scope="col">Person</th>
											<th scope="col">Use</th>
											<th scope="col">Model</th>
											<th scope="col" className="pk-num">
												Input tokens
											</th>
											<th scope="col" className="pk-num">
												Output tokens
											</th>
											<th scope="col" className="pk-num">
												<span className="inline-flex items-center gap-1">
													Cache tokens
													<Toggletip label="Cache tokens">{CACHE_HELP}</Toggletip>
												</span>
											</th>
										</tr>
									</thead>
									<tbody>
										{data.users.map((row) => (
											<tr key={`${row.userId}-${row.purpose}-${row.model}`}>
												<th scope="row" className={LEAD_CELL_CLASS}>
													{row.displayName}
												</th>
												<td className="pk-usage-agent">{PURPOSE_NAME[row.purpose]}</td>
												<td className="break-all" data-label="Model">
													{row.model}
												</td>
												<td className="pk-num" data-label="Input">
													{count(row.inputTokens)}
												</td>
												<td className="pk-num" data-label="Output">
													{count(row.outputTokens)}
												</td>
												<td className="pk-num" data-label="Cache">
													{count(row.cacheReadTokens + row.cacheWriteTokens)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</div>
					)}
				</>
			) : null}
		</AdminGroup>
	);
}
