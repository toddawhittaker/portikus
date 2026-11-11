/**
 * Each project's agent tabs and their subagents, under its row in the project
 * list (SPEC.md §8.2). Every row is a link to its tab; a subagent's link also
 * opens its tool row in a chat, and its own conversation in a panel there. A chat's row shows its conversation title and
 * a pencil that renames it (ADR 0074). The state is part of each link's name
 * and nothing here is announced as it changes: the toasts already do that
 * (SPEC.md §25.8).
 */
import {
	agentTitleText,
	type CodingAgentSubagent,
	type CodingAgentTerminal,
	MAX_AGENT_TITLE_CHARS,
} from "@portikus/contracts";
import { AgentStateMark, agentStateWords, IconButton, useToast } from "@portikus/ui";
import { Link } from "@tanstack/react-router";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { isoDuration } from "../chat/elapsed.js";
import { requestSubagentView } from "../chat/subagentView.js";
import { agentLabel } from "../terminal/agentLabel.js";
import type { AgentStatusSnapshot } from "../terminal/codingAgentStatus.js";
import { type ChatRename, renameChat } from "./renameChat.js";
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

/** Only a Claude Code chat has a title Portikus can read and change. */
export function canRename(terminal: CodingAgentTerminal): boolean {
	return terminal.kind === "chat" && terminal.agent === "claude";
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
	inChat,
}: {
	workspaceId: string;
	projectId: string;
	terminalId: string;
	subagent: CodingAgentSubagent;
	/** The agent is a Claude Code chat, which can show the subagent's own conversation. */
	inChat: boolean;
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
				onClick={() => {
					if (inChat) {
						requestSubagentView(terminalId, {
							toolUseId: subagent.id,
							title: description,
						});
					}
				}}
			>
				<AgentStateMark state={subagent.state} />
				{/* The spaces keep the link's name apart; a flex row does not draw them. */}
				<span className="pk-agent-name" title={description}>
					{description}
				</span>{" "}
				<span className="pk-agent-type">{subagent.type}</span>{" "}
				<span className="pk-visually-hidden">({subagent.state})</span>
			</Link>
		</li>
	);
}

/**
 * A rename in flight: the title shown until the agent status carries it, and
 * the socket that sent it.
 */
interface PendingRename {
	title: string;
	rename: ChatRename;
}

/** A chat's title, edited in place: Enter saves, Escape or leaving cancels. */
function TitleEditor({
	label,
	initial,
	onSave,
	onCancel,
}: {
	label: string;
	initial: string;
	onSave: (title: string) => void;
	onCancel: () => void;
}) {
	const input = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, []);
	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === "Escape") {
			// Escape ends the edit only, not a drawer around the list.
			event.preventDefault();
			event.stopPropagation();
			onCancel();
		}
	}
	return (
		<form
			className="pk-agent-row pk-agent-edit"
			onSubmit={(event) => {
				event.preventDefault();
				onSave(input.current?.value ?? "");
			}}
		>
			<input
				ref={input}
				className="pk-agent-title-input"
				aria-label={label}
				defaultValue={initial}
				maxLength={MAX_AGENT_TITLE_CHARS}
				onKeyDown={onKeyDown}
				onBlur={onCancel}
				data-testid="agent-title-input"
			/>
		</form>
	);
}

function AgentRow({
	workspaceId,
	projectId,
	terminal,
	now,
	isUnread,
	isCurrent,
}: {
	workspaceId: string;
	projectId: string;
	terminal: CodingAgentTerminal;
	now: number;
	isUnread: boolean;
	isCurrent: boolean;
}) {
	const toast = useToast();
	const [editing, setEditing] = useState(false);
	const [pending, setPending] = useState<PendingRename | null>(null);
	const pencil = useRef<HTMLButtonElement | null>(null);
	const name = agentRowName(terminal);
	const title = pending?.title ?? terminal.title;
	const length = now - Date.parse(terminal.since);

	// The new title has come back through the agent status: the rename is done.
	useEffect(() => {
		if (pending && terminal.title === pending.title) pending.rename.finish();
	}, [pending, terminal.title]);

	function stopEditing() {
		setEditing(false);
		// The pencil comes back once the editor goes; focus returns to it.
		requestAnimationFrame(() => pencil.current?.focus());
	}

	function save(raw: string) {
		stopEditing();
		const next = agentTitleText(raw);
		if (next === "" || next === terminal.title) return;
		const rename = renameChat(workspaceId, terminal.terminalId, next);
		const mine: PendingRename = { title: next, rename };
		setPending(mine);
		rename.done
			.catch((error: unknown) => {
				toast.show({
					tone: "danger",
					title: "The chat was not renamed",
					children: error instanceof Error ? error.message : undefined,
				});
			})
			.finally(() => setPending((current) => (current === mine ? null : current)));
	}

	return (
		<li>
			<div className="pk-agent-line">
				{editing ? (
					<TitleEditor
						label={`Title of ${name}`}
						initial={title ?? ""}
						onSave={save}
						onCancel={stopEditing}
					/>
				) : (
					<Link
						className={`pk-agent-row${isUnread ? " is-unread" : ""}${isCurrent ? " is-current" : ""}`}
						to="/workspaces/$id/projects/$projectId"
						params={{ id: workspaceId, projectId }}
						search={{ tab: terminal.terminalId }}
						aria-current={isCurrent ? "page" : undefined}
						data-testid={`agent-row-${terminal.terminalId}`}
					>
						<AgentStateMark state={terminal.state} unread={isUnread} />
						<span className="pk-agent-name" title={name}>
							{name}
						</span>{" "}
						{title ? (
							<>
								<span
									className="pk-agent-title"
									title={title}
									data-testid={`agent-title-${terminal.terminalId}`}
								>
									{title}
								</span>{" "}
							</>
						) : null}
						<span className="pk-agent-state">
							{capitalised(agentStateWords(terminal.state))}{" "}
							<time dateTime={isoDuration(length)} aria-hidden="true">
								{shortElapsed(length)}
							</time>
							{isUnread && terminal.state !== "working" ? (
								<span className="pk-visually-hidden">, unread</span>
							) : null}
						</span>
					</Link>
				)}
				{canRename(terminal) && !editing ? (
					<IconButton
						ref={pencil}
						icon="pencil"
						label={`Rename ${title ?? name}`}
						size="sm"
						className="pk-agent-rename"
						data-testid={`agent-rename-${terminal.terminalId}`}
						onClick={() => setEditing(true)}
					/>
				) : null}
			</div>
			{terminal.subagents.length > 0 ? (
				<ul className="pk-agents pk-agents--sub">
					{terminal.subagents.map((subagent) => (
						<SubagentRow
							key={subagent.id}
							workspaceId={workspaceId}
							projectId={projectId}
							terminalId={terminal.terminalId}
							subagent={subagent}
							inChat={canRename(terminal)}
						/>
					))}
				</ul>
			) : null}
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
	currentTabId,
}: {
	workspaceId: string;
	projectId: string;
	projectName: string;
	listId: string;
	expanded: boolean;
	terminals: readonly CodingAgentTerminal[];
	unread: AgentStatusSnapshot["unread"];
	/** The tab on show in this project's work area, or null in any other project. */
	currentTabId: string | null;
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
			{terminals.map((terminal) => (
				<AgentRow
					key={terminal.terminalId}
					workspaceId={workspaceId}
					projectId={projectId}
					terminal={terminal}
					now={now}
					isUnread={unread.has(terminal.terminalId)}
					isCurrent={terminal.terminalId === currentTabId}
				/>
			))}
		</ul>
	);
}
