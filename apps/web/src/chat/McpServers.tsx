/**
 * The student's MCP servers and how each stands, read only (SPEC.md §10.8).
 * A field in Chat options, drawn like the pickers beside
 * it, discloses the list; `/mcp` opens it from the message box. The host
 * sends names and states only, never an address, tool or error (ADR 0012).
 * Servers are added, signed in to and removed in a terminal, for both agents.
 */
import type { ChatMcpServer, ChatMcpStatus, CodingAgent } from "@portikus/contracts";
import { Icon } from "@portikus/ui";
import { type Ref, useId } from "react";

const MCP_STATUS_WORDS: Record<ChatMcpStatus, string> = {
	connected: "Connected",
	starting: "Starting",
	failed: "Failed",
	needsAuth: "Needs sign-in",
	disabled: "Disabled",
};

/** The command that manages each agent's servers in a terminal. */
const MANAGE: Record<CodingAgent, string> = {
	claude: "claude mcp",
	codex: "codex mcp",
};

/** The field's value: "None", "2 connected", or "1 of 3 connected". */
function mcpSummary(servers: readonly ChatMcpServer[]): string {
	if (servers.length === 0) return "None";
	const connected = servers.filter((server) => server.status === "connected").length;
	return connected === servers.length
		? `${connected} connected`
		: `${connected} of ${servers.length} connected`;
}

interface McpServersProps {
	servers: readonly ChatMcpServer[];
	agent: CodingAgent;
	expanded: boolean;
	onExpandedChange: (expanded: boolean) => void;
	ref?: Ref<HTMLButtonElement>;
}

export function McpServers({
	servers,
	agent,
	expanded,
	onExpandedChange,
	ref,
}: McpServersProps) {
	const listId = useId();
	return (
		<>
			<button
				ref={ref}
				type="button"
				className="pk-picker"
				aria-expanded={expanded}
				aria-controls={listId}
				data-testid="composer-mcp"
				onClick={() => onExpandedChange(!expanded)}
			>
				{/* The space keeps the name "MCP servers 2 connected". */}
				<span className="pk-picker-label">MCP servers</span>{" "}
				<span className="pk-picker-current">
					<span className="pk-picker-value">{mcpSummary(servers)}</span>
					<Icon name={expanded ? "chevron-up" : "chevron-down"} size="sm" />
				</span>
			</button>
			<section
				id={listId}
				className="pk-mcp"
				aria-label="MCP servers"
				hidden={!expanded}
				data-testid="composer-mcp-list"
			>
				{servers.length > 0 ? (
					<ul className="pk-mcp-list">
						{servers.map((server) => (
							<li
								key={server.name}
								className="pk-mcp-row"
								data-testid={`composer-mcp-${server.name}`}
							>
								<span className="pk-mcp-name" title={server.name}>
									{server.name}
								</span>{" "}
								<span className="pk-mcp-status" data-status={server.status}>
									<span className="pk-mcp-dot" aria-hidden={true} />
									{MCP_STATUS_WORDS[server.status]}
								</span>
							</li>
						))}
					</ul>
				) : (
					<p className="pk-mcp-note">No MCP servers are set up.</p>
				)}
				<p className="pk-mcp-note">
					Servers are managed in a terminal, with <code>{MANAGE[agent]}</code>.
				</p>
			</section>
		</>
	);
}
