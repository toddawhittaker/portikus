/**
 * The choices of what a new pane runs, shared by the New tab menu and the
 * pane menu's Split right and Split down (SPEC.md §8.7, §10.8).
 */
import type { CodingAgent } from "@portikus/contracts";
import { type Key, MenuItem } from "@portikus/ui";

/** What a new pane runs: a shell, a coding agent's terminal, or a chat. */
export type Launch =
	| { kind: "terminal" }
	| { kind: "agent"; agent: CodingAgent }
	| { kind: "chat" };

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
			{traditional ? null : (
				<>
					<MenuItem
						icon="agent"
						onSelect={() => onLaunch({ kind: "agent", agent: "claude" })}
					>
						<span data-testid={`${testIdPrefix}-claude`}>Claude Code (TUI)</span>
					</MenuItem>
					<MenuItem icon="agent" onSelect={() => onLaunch({ kind: "chat" })}>
						<span data-testid={`${testIdPrefix}-claude-gui`}>Claude Code (GUI)</span>
					</MenuItem>
					<MenuItem
						icon="agent"
						onSelect={() => onLaunch({ kind: "agent", agent: "codex" })}
					>
						<span data-testid={`${testIdPrefix}-codex`}>Codex</span>
					</MenuItem>
				</>
			)}
		</>
	);
}

/** The terminal-create request that starts what `launch` names. */
export function launchInit(
	launch: Launch,
): { agent: CodingAgent } | { kind: "chat"; agent: "claude" } | undefined {
	if (launch.kind === "agent") return { agent: launch.agent };
	if (launch.kind === "chat") return { kind: "chat", agent: "claude" };
	return undefined;
}
