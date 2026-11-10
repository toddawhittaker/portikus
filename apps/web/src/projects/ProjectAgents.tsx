/**
 * Each project's agent tabs and their subagents, under its row in the project
 * list (SPEC.md §8.2). Every row is a link to its tab; a subagent's link also
 * opens its tool row in a chat. The state is part of each link's name and
 * nothing here is announced as it changes: the toasts already do that
 * (SPEC.md §25.8).
 */
import type { CodingAgentSubagent, CodingAgentTerminal } from "@portikus/contracts";
import { AgentStateMark, agentStateWords, IconButton } from "@portikus/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isoDuration } from "../chat/elapsed.js";
import { agentLabel } from "../terminal/agentLabel.js";
import type { AgentStatusSnapshot } from "../terminal/codingAgentStatus.js";
import "./project-agents.css";

/** The agent tabs that have reported a state, by project, in the order they came. */
export function agentsByProject(
	terminals: readonly CodingAgentTerminal[],
): Map<string, CodingAgentTerminal[]> {
	const grouped = new Map<string, CodingAgentTerminal[]>();
	for (const terminal of terminals) {
		const list = grouped.get(terminal.projectId) ?? [];
		list.push(terminal);
		grouped.set(terminal.projectId, list);
	}
	return grouped;
}

/** A short length for a row: "12s", "4m", "1h 5m". */
export function shortElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The row's name, the same words its tab shows. */
export function agentRowName(terminal: CodingAgentTerminal): string {
	return agentLabel(terminal) ?? terminal.name;
}

function capitalised(words: string): string {
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Ticks once a second while the rows are shown, for their elapsed times. */
function useNow(running: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!running) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [running]);
	return now;
}

/** The disclosure on a project's row that shows or hides its agents. */
export function AgentsToggle({
	projectId,
	projectName,
	listId,
	expanded,
	onToggle,
}: {
	projectId: string;
	projectName: string;
	listId: string;
	expanded: boolean;
	onToggle: () => void;
}) {
	return (
		<IconButton
			icon={expanded ? "chevron-down" : "chevron-right"}
			label={`Agents in ${projectName}`}
			size="sm"
			aria-expanded={expanded}
			aria-controls={listId}
			data-testid={`project-agents-toggle-${projectId}`}
			onClick={onToggle}
		/>
	);
}

function SubagentRow({
	workspaceId,
	projectId,
	terminalId,
	subagent,
}: {
	workspaceId: string;
	projectId: string;
	terminalId: string;
	subagent: CodingAgentSubagent;
}) {
	const description = subagent.description || subagent.type;
	return (
		<li>
			<Link
				className="pk-agent-row pk-agent-row--sub"
				to="/workspaces/$id/projects/$projectId"
				params={{ id: workspaceId, projectId }}
				search={{ tab: terminalId, subagent: subagent.id }}
				data-testid={`subagent-row-${subagent.id}`}
			>
				<AgentStateMark state={subagent.state} />
				{/* The spaces keep the link's name apart; a flex row does not draw them. */}
				<span className="pk-agent-name">{description}</span>{" "}
				<span className="pk-agent-type">{subagent.type}</span>{" "}
				<span className="pk-visually-hidden">({subagent.state})</span>
			</Link>
		</li>
	);
}

/** The list under one project's row; `hidden` while its disclosure is closed. */
export function ProjectAgents({
	workspaceId,
	projectId,
	projectName,
	listId,
	expanded,
	terminals,
	unread,
}: {
	workspaceId: string;
	projectId: string;
	projectName: string;
	listId: string;
	expanded: boolean;
	terminals: readonly CodingAgentTerminal[];
	unread: AgentStatusSnapshot["unread"];
}) {
	const now = useNow(expanded);
	return (
		<ul
			id={listId}
			className="pk-agents"
			aria-label={`Agents in ${projectName}`}
			hidden={!expanded}
			data-testid={`project-agents-${projectId}`}
		>
			{terminals.map((terminal) => {
				const isUnread = unread.has(terminal.terminalId);
				const length = now - Date.parse(terminal.since);
				return (
					<li key={terminal.terminalId}>
						<Link
							className={`pk-agent-row${isUnread ? " is-unread" : ""}`}
							to="/workspaces/$id/projects/$projectId"
							params={{ id: workspaceId, projectId }}
							search={{ tab: terminal.terminalId }}
							data-testid={`agent-row-${terminal.terminalId}`}
						>
							<AgentStateMark state={terminal.state} unread={isUnread} />
							<span className="pk-agent-name">{agentRowName(terminal)}</span>{" "}
							<span className="pk-agent-state">
								{capitalised(agentStateWords(terminal.state))}{" "}
								<time dateTime={isoDuration(length)}>{shortElapsed(length)}</time>
								{isUnread && terminal.state !== "working" ? (
									<span className="pk-visually-hidden">, unread</span>
								) : null}
							</span>
						</Link>
						{terminal.subagents.length > 0 ? (
							<ul className="pk-agents pk-agents--sub">
								{terminal.subagents.map((subagent) => (
									<SubagentRow
										key={subagent.id}
										workspaceId={workspaceId}
										projectId={projectId}
										terminalId={terminal.terminalId}
										subagent={subagent}
									/>
								))}
							</ul>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}
