import type {
	CodingAgentsFile,
	CodingAgentTool,
	ImageJobRequest,
} from "@portikus/contracts";
import { Button, ConfirmDialog, ConfirmDialogRoot } from "@portikus/ui";
import { useState } from "react";
import { AdminGroup as Group } from "../AdminSection.js";
import { CODING_AGENT_NAME } from "./codingAgents.js";
import { IMAGE_BUSY_REASON, RowAction } from "./RowAction.js";

const TOOLS: CodingAgentTool[] = ["claude", "codex"];

const BUSY_NOTE = "image-agents-busy-note";

type Confirming =
	| { kind: "agents-update" }
	| { kind: "agents-rollback"; tool: CodingAgentTool };

/**
 * Claude Code and Codex in the shared folder every workspace reads, so they
 * update without a new image (SPEC.md sections 21.7 and 22.4).
 */
export function CodingAgentsSection({
	agents,
	busy,
	pending,
	submit,
}: {
	agents: CodingAgentsFile | null;
	/** An image job is queued or running. */
	busy: boolean;
	pending: boolean;
	submit: (body: ImageJobRequest, done: () => void) => void;
}) {
	const [confirming, setConfirming] = useState<Confirming | null>(null);
	return (
		<Group
			id="image-agents-title"
			title="Coding agents"
			testId="image-agents"
			description="Claude Code and Codex run from a shared folder on this host, so updating them needs no new image."
			actions={
				agents ? (
					<Button
						variant="primary"
						data-testid="image-agents-update"
						aria-disabled={busy ? true : undefined}
						aria-describedby={busy ? BUSY_NOTE : undefined}
						onClick={() =>
							busy ? undefined : setConfirming({ kind: "agents-update" })
						}
					>
						Update coding agents
					</Button>
				) : null
			}
		>
			{agents && busy ? (
				<p id={BUSY_NOTE} className="pk-muted m-0 text-[13px]">
					{IMAGE_BUSY_REASON}
				</p>
			) : null}
			{agents ? (
				<div className="pk-table-wrap">
					<table className="pk-table" data-testid="image-agents-table">
						<caption className="sr-only">Coding agent versions</caption>
						<thead>
							<tr>
								<th scope="col">Tool</th>
								<th scope="col">In use</th>
								<th scope="col">Previous</th>
								<th scope="col">
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{TOOLS.map((tool) => {
								const name = CODING_AGENT_NAME[tool];
								const { current, previous } = agents[tool];
								return (
									<tr key={tool} data-testid={`image-agents-row-${tool}`}>
										<th scope="row">{name}</th>
										<td
											className="pk-mono-small"
											data-testid={`image-agents-current-${tool}`}
										>
											{current ?? "Not installed"}
										</td>
										<td
											className="pk-mono-small"
											data-testid={`image-agents-previous-${tool}`}
										>
											{previous ?? "None"}
										</td>
										<td>
											<RowAction
												label="Roll back"
												ariaLabel={`Roll back ${name}`}
												testId={`image-agents-rollback-${tool}`}
												reason={previous ? null : "No previous version."}
												busy={busy}
												busyNoteId={BUSY_NOTE}
												onPress={() => setConfirming({ kind: "agents-rollback", tool })}
											/>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			) : (
				<p className="pk-muted m-0 text-[13px]" data-testid="image-agents-none">
					Claude Code and Codex are not set up on this host yet. Run{" "}
					<code className="pk-mono-small">sudo portikus setup</code> on the host to
					install them.
				</p>
			)}

			<ConfirmDialogRoot
				open={confirming !== null}
				onOpenChange={(open) => (open ? undefined : setConfirming(null))}
			>
				{confirming && agents ? (
					<ConfirmDialog
						id="image-agents-confirm"
						testId="image-agents-confirm"
						title={confirmTitle(confirming, agents)}
						description={confirmText(confirming, agents)}
						confirmLabel={confirming.kind === "agents-update" ? "Update" : "Roll back"}
						pending={pending}
						onConfirm={() => submit(confirming, () => setConfirming(null))}
					/>
				) : null}
			</ConfirmDialogRoot>
		</Group>
	);
}

function confirmTitle(c: Confirming, agents: CodingAgentsFile): string {
	if (c.kind === "agents-update") return "Update Claude Code and Codex?";
	return `Roll back ${CODING_AGENT_NAME[c.tool]} to ${agents[c.tool].previous}?`;
}

function confirmText(c: Confirming, agents: CodingAgentsFile): string {
	const sessions = "Open sessions keep the version they started with.";
	if (c.kind === "agents-update") {
		return `The host downloads the newest version of each, checks it and switches each one that passes. Students get the new version the next time they start it. ${sessions}`;
	}
	return `Students get ${agents[c.tool].previous} the next time they start ${CODING_AGENT_NAME[c.tool]}. ${sessions} The version in use now becomes the previous one.`;
}
