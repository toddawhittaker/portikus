/**
 * The choices of what a new pane runs, shared by the New tab menu and the
 * pane menu's Split right and Split down (SPEC.md §8.7, §10.8).
 */
import type { CodingAgent, TerminalKind } from "@portikus/contracts";
import { type Key, MenuItem } from "@portikus/ui";
import { agentTabName } from "../agents/codingAgentName.js";

/** What a new pane runs: a shell, a coding agent's terminal, or a coding agent's chat. */
export type Launch =
	| { kind: "terminal" }
	| { kind: "agent"; agent: CodingAgent }
	| { kind: "chat"; agent: CodingAgent };

/** Each agent's GUI then its TUI, with the test id each entry has always had. */
const AGENT_LAUNCHES: { agent: CodingAgent; kind: TerminalKind; testId: string }[] = [
	{ agent: "claude", kind: "chat", testId: "claude-gui" },
	{ agent: "claude", kind: "terminal", testId: "claude" },
	{ agent: "codex", kind: "chat", testId: "codex-gui" },
	{ agent: "codex", kind: "terminal", testId: "codex" },
];

export interface LauncherItemsProps {
	/** Starts every item's test id, as in `<prefix>-terminal`. */
	testIdPrefix: string;
	/** The Traditional course profile hides the agent entries (SPEC.md §8.7). */
	traditional: boolean;
	onLaunch: (launch: Launch) => void;
	terminalShortcut?: Key[];
}

export function LauncherItems({
	testIdPrefix,
	traditional,
	onLaunch,
	terminalShortcut,
}: LauncherItemsProps) {
	return (
		<>
			<MenuItem
				icon="terminal"
				shortcut={terminalShortcut}
				onSelect={() => onLaunch({ kind: "terminal" })}
			>
				<span data-testid={`${testIdPrefix}-terminal`}>Terminal</span>
			</MenuItem>
			{traditional
				? null
				: AGENT_LAUNCHES.map(({ agent, kind, testId }) => (
						<MenuItem
							key={testId}
							icon="agent"
							onSelect={() =>
								onLaunch(kind === "chat" ? { kind, agent } : { kind: "agent", agent })
							}
						>
							<span data-testid={`${testIdPrefix}-${testId}`}>
								{agentTabName(agent, kind)}
							</span>
						</MenuItem>
					))}
		</>
	);
}

/** The terminal-create request that starts what `launch` names. */
export function launchInit(
	launch: Launch,
): { agent: CodingAgent } | { kind: "chat"; agent: CodingAgent } | undefined {
	if (launch.kind === "agent") return { agent: launch.agent };
	if (launch.kind === "chat") return { kind: "chat", agent: launch.agent };
	return undefined;
}
