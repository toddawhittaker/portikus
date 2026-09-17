import type { Terminal } from "@portikus/contracts";
import { useState } from "react";

export interface TerminalTabsProps {
	terminals: Terminal[];
	activeId: string | null;
	onSelect: (terminalId: string) => void;
	onCreate: () => void;
	onRename: (terminalId: string, name: string) => void;
	onClose: (terminalId: string) => void;
	/** Start a fresh terminal with the same name and directory as an ended one. */
	onRestart: (terminal: Terminal) => void;
}

/**
 * The terminal tab strip (SPEC.md §9.3). An ended terminal is shown as ended
 * with an action to create a new one (SPEC.md §6.8, §9.7). Splits and drag
 * reordering are not built yet.
 */
export function TerminalTabs({
	terminals,
	activeId,
	onSelect,
	onCreate,
	onRename,
	onClose,
	onRestart,
}: TerminalTabsProps) {
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [draft, setDraft] = useState("");

	function startRename(terminal: Terminal) {
		setRenamingId(terminal.id);
		setDraft(terminal.name);
	}

	function commitRename(terminalId: string) {
		const name = draft.trim();
		if (name.length > 0) onRename(terminalId, name);
		setRenamingId(null);
	}

	return (
		<div className="pk-terminal-tabs" role="tablist" aria-label="Terminals">
			{terminals.map((terminal) => {
				const ended = terminal.endedAt !== null;
				if (renamingId === terminal.id) {
					return (
						<input
							key={terminal.id}
							// biome-ignore lint/a11y/noAutofocus: the input replaces the tab the user just opened.
							autoFocus
							aria-label={`Rename ${terminal.name}`}
							className="pk-terminal-tab-input"
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
							onBlur={() => setRenamingId(null)}
							onKeyDown={(event) => {
								if (event.key === "Enter") commitRename(terminal.id);
								if (event.key === "Escape") setRenamingId(null);
							}}
						/>
					);
				}
				return (
					<span
						key={terminal.id}
						className={
							ended ? "pk-terminal-tab pk-terminal-tab--ended" : "pk-terminal-tab"
						}
						data-testid={`terminal-tab-${terminal.id}`}
					>
						<button
							type="button"
							role="tab"
							aria-selected={terminal.id === activeId}
							onClick={() => onSelect(terminal.id)}
							onDoubleClick={() => startRename(terminal)}
						>
							{terminal.name}
							{ended && <span className="pk-terminal-tab-ended"> (ended)</span>}
						</button>
						{ended ? (
							<button
								type="button"
								aria-label={`New terminal like ${terminal.name}`}
								onClick={() => onRestart(terminal)}
							>
								New terminal
							</button>
						) : null}
						<button
							type="button"
							aria-label={`Close ${terminal.name}`}
							onClick={() => onClose(terminal.id)}
						>
							x
						</button>
					</span>
				);
			})}
			<button type="button" aria-label="New terminal" onClick={onCreate}>
				+
			</button>
		</div>
	);
}
