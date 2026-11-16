import type { AiSettingsView, PriceRun } from "@portikus/contracts";
import { Badge, Button } from "@portikus/ui";
import { errorText } from "../../api/request.js";
import { AdminGroup } from "../AdminSection.js";
import { switchBlocked } from "../ai/text.js";
import { useRefresh } from "./queries.js";
import { runFailures, STATUS_LABEL, TRIGGER_LABEL, when } from "./text.js";

const BADGE_TONE = { running: "info", done: "success", failed: "danger" } as const;
const REASON = "pricing-run-reason";
export const SOURCES_HEADING = "pricing-sources-title";

/** Why a check cannot start, or null when it can. */
function runBlocked(ai: AiSettingsView | undefined, run: PriceRun | null) {
	if (run?.status === "running")
		return "A check is running. This page updates when it ends.";
	if (!ai) return null;
	const blocked = switchBlocked(ai);
	if (blocked) return `${blocked.replace(/\.$/, "")} on the AI tab.`;
	if (!ai.enabled) return "Turn on the assistant on the AI tab first.";
	return null;
}

/** Ask the model to read the pricing pages, and show how the last check went (SPEC.md section 20.4). */
export function RunGroup({
	run,
	ai,
}: {
	run: PriceRun | null;
	ai: AiSettingsView | undefined;
}) {
	const refresh = useRefresh();
	const blocked = runBlocked(ai, run);
	const failures = runFailures(run?.errorCode ?? null);
	return (
		<AdminGroup
			id="pricing-run-title"
			title="Price check"
			testId="pricing-run"
			description="The model reads each source page and proposes rows. Nothing changes until you accept a row. A check also runs every week."
		>
			<div className="grid gap-1">
				<div>
					<Button
						variant="primary"
						data-testid="pricing-refresh"
						loading={refresh.isPending}
						aria-disabled={blocked !== null || undefined}
						aria-describedby={blocked ? REASON : undefined}
						onClick={() => {
							if (blocked === null && !refresh.isPending) refresh.mutate();
						}}
					>
						Check prices now
					</Button>
				</div>
				{blocked ? (
					<p
						id={REASON}
						className="pk-muted m-0 text-[13px]"
						data-testid="pricing-refresh-reason"
					>
						{blocked}
					</p>
				) : null}
				{refresh.isError ? (
					<p className="m-0 text-[13px] text-status-error" role="alert">
						{errorText(refresh.error)}
					</p>
				) : null}
			</div>
			{run ? (
				<div className="grid gap-3" data-testid="pricing-last-run">
					<dl className="pk-dl m-0 grid gap-x-6 gap-y-1 [grid-template-columns:max-content_1fr] text-[14px]">
						<dt className="text-ink-muted">Last check</dt>
						<dd className="m-0">
							<time dateTime={run.startedAt}>{when(run.startedAt)}</time>
						</dd>
						<dt className="text-ink-muted">Started by</dt>
						<dd className="m-0">{TRIGGER_LABEL[run.trigger]}</dd>
						<dt className="text-ink-muted">Status</dt>
						<dd className="m-0">
							<span role="status" data-testid="pricing-run-status">
								<Badge tone={BADGE_TONE[run.status]}>{STATUS_LABEL[run.status]}</Badge>
							</span>
						</dd>
						{run.status !== "running" ? (
							<>
								<dt className="text-ink-muted">Proposed</dt>
								<dd className="m-0">
									{run.proposalCount === 1 ? "1 row" : `${run.proposalCount} rows`}
								</dd>
							</>
						) : null}
					</dl>
					{failures.length > 0 ? (
						<ul
							className="m-0 grid list-none gap-2 p-0"
							data-testid="pricing-run-failures"
						>
							{failures.map((f) => (
								<li
									key={`${f.host} ${f.code}`}
									className="text-[14px]"
									data-code={f.code}
								>
									{f.host ? (
										<code className="pk-mono-body font-medium [overflow-wrap:anywhere]">
											{f.host}
										</code>
									) : null}
									{f.host ? ": " : null}
									{f.text}
									{f.proxy ? (
										<>
											{" "}
											<a className="pk-link" href={`#${SOURCES_HEADING}`}>
												Go to Sources
											</a>
										</>
									) : null}
								</li>
							))}
						</ul>
					) : null}
				</div>
			) : (
				<p className="pk-muted m-0 text-[14px]">No check has run yet.</p>
			)}
		</AdminGroup>
	);
}
