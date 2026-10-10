import { type AgentLogLine, AgentLogResponse } from "@portikus/contracts";
import { Button, Toggletip } from "@portikus/ui";
import { useState } from "react";
import { errorText, request } from "../../api/request.js";
import { shortTime } from "../../text.js";
import { SECTION_HEADING } from "./shared.js";

/** The agent runs as the student, so its lines are its own account (ADR 0060). */
const REPORTED_HELP =
	"These are the workspace agent's own recent warnings and errors, kept in memory inside the workspace. The workspace's owner can change what it reports, so treat them as hints, not proof.";

type Reading =
	| { phase: "idle" }
	| { phase: "waiting" }
	| { phase: "done"; lines: AgentLogLine[] }
	| { phase: "failed"; message: string };

/** Extra fields a line may carry, shown after its message. */
function details(line: AgentLogLine): string {
	const parts: string[] = [];
	if (line.code !== undefined) parts.push(line.code);
	if (line.status !== undefined) parts.push(String(line.status));
	if (line.durationMs !== undefined) parts.push(`${Math.round(line.durationMs)} ms`);
	return parts.join(" · ");
}

/** The workspace agent's recent warnings, read on demand (SPEC.md 20.1). */
export function AgentLogSection({
	workspaceId,
	running,
}: {
	workspaceId: string;
	running: boolean;
}) {
	const [reading, setReading] = useState<Reading>({ phase: "idle" });

	async function read() {
		setReading({ phase: "waiting" });
		try {
			const body = await request(
				AgentLogResponse,
				`/admin/workspaces/${workspaceId}/agent-log`,
			);
			setReading({ phase: "done", lines: body.lines });
		} catch (error) {
			setReading({
				phase: "failed",
				message: errorText(error, "The agent log could not be read. Try again."),
			});
		}
	}

	return (
		<section
			aria-labelledby="detail-agent-log"
			className="pk-detail-section"
			data-testid="detail-agent-log"
		>
			<div className="flex items-start gap-0.5">
				<h4 id="detail-agent-log" className={`${SECTION_HEADING} pt-0.5`}>
					Agent log, reported by the workspace
				</h4>
				<Toggletip label="Agent log">{REPORTED_HELP}</Toggletip>
			</div>
			<div role="status" aria-live="polite">
				{!running ? (
					<p className="pk-text-compact pk-muted m-0">The workspace is not running.</p>
				) : reading.phase === "idle" ? (
					<p className="pk-text-compact pk-muted m-0">
						Press Read log to ask the workspace for its recent warnings.
					</p>
				) : reading.phase === "waiting" ? (
					<p className="pk-text-compact pk-muted m-0" aria-busy="true">
						Reading the log…
					</p>
				) : reading.phase === "failed" ? (
					<p
						className="pk-text-compact m-0 text-status-error"
						data-testid="agent-log-error"
					>
						{reading.message}
					</p>
				) : reading.lines.length === 0 ? (
					<p className="pk-text-compact pk-muted m-0">No warnings reported.</p>
				) : (
					<p className="sr-only">{reading.lines.length} lines reported.</p>
				)}
			</div>
			{reading.phase === "done" && reading.lines.length > 0 ? (
				<ul
					className="pk-text-compact m-0 flex list-none flex-col gap-1 p-0"
					data-testid="agent-log-lines"
				>
					{reading.lines.map((line, index) => (
						// Lines have no id, and the list is replaced whole on each read.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above
						<li key={index} className="flex min-w-0 gap-2">
							<time dateTime={line.time} className="pk-muted flex-none">
								{shortTime(line.time)}
							</time>
							<span className="pk-mono-small flex-none">{line.level}</span>
							<span className="min-w-0 break-words">
								{line.msg}
								{details(line) === "" ? null : (
									<span className="pk-muted"> · {details(line)}</span>
								)}
							</span>
						</li>
					))}
				</ul>
			) : null}
			{running ? (
				<div className="pk-actions">
					<Button
						size="sm"
						loading={reading.phase === "waiting"}
						onClick={() => void read()}
						data-testid="agent-log-read"
					>
						Read log
					</Button>
				</div>
			) : null}
		</section>
	);
}
