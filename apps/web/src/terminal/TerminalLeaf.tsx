/**
 * One terminal pane inside a split: the pane frame around the terminal
 * itself (SPEC.md §9.3). A terminal ended by a workspace stop keeps its
 * place and offers a new one (SPEC.md §6.8).
 */
import type { Terminal, TerminalTheme } from "@portikus/contracts";
import { Button } from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import type { DropEdge, SplitDirection } from "../layout/tree.js";
import { PaneFrame } from "./PaneFrame.js";
import { TerminalPane } from "./TerminalPane.js";
import { useSpeechInput } from "./useSpeechInput.js";

export interface TerminalLeafProps {
	workspaceId: string;
	projectId: string;
	terminal: Terminal;
	visible: boolean;
	focused: boolean;
	onFocus: (terminalId: string) => void;
	onSplit: (terminalId: string, direction: SplitDirection) => void;
	onRename: (terminalId: string, name: string) => void;
	/** Switch this one terminal between the light and dark scheme. */
	onSetTheme: (terminalId: string, theme: TerminalTheme) => void;
	onClose: (terminalId: string) => void;
	onExited: (terminalId: string) => void;
	onReplace: (terminalId: string) => void;
	onLeave: () => void;
	/** Give this pane a tab of its own, the keyboard way to drag it. */
	onMoveToNewTab: (terminalId: string) => void;
	/** The other tabs this pane can join, named as the tab strip names them. */
	moveTargets: { tabId: string; label: string }[];
	/** Put this pane into another tab's split, the click way to drag it there. */
	onMoveInto: (terminalId: string, tabId: string) => void;
	/** Share this tab's space out evenly again, the click way to drag splitters. */
	onResetSizes: () => void;
	/** The only pane in its tab, which already has a tab of its own. */
	alone: boolean;
	/** The zone to shade while a pane is being dragged over this one. */
	dropEdge?: DropEdge | null;
}

/** `/home/student/projects/x` reads as `~/projects/x` to a student. */
export function shortenPath(path: string): string {
	return path.startsWith("/home/student")
		? `~${path.slice("/home/student".length)}`
		: path;
}

export function TerminalLeaf({
	workspaceId,
	projectId,
	terminal,
	visible,
	focused,
	onFocus,
	onSplit,
	onRename,
	onSetTheme,
	onClose,
	onExited,
	onReplace,
	onLeave,
	onMoveToNewTab,
	moveTargets,
	onMoveInto,
	onResetSizes,
	alone,
	dropEdge = null,
}: TerminalLeafProps) {
	// The agent reports the directory as the student cds around (SPEC.md §9.3).
	const [liveCwd, setLiveCwd] = useState(terminal.cwd);
	const ended = terminal.endedAt !== null;
	const title = `${terminal.name} · ${shortenPath(liveCwd)}`;
	// Voice input types into this pane's terminal through the ref it fills.
	const dictation = useRef<((text: string) => void) | null>(null);
	const speech = useSpeechInput((text) => dictation.current?.(text));
	const stopSpeech = speech.stop;
	// A terminal that ends mid-dictation must not keep the microphone open.
	useEffect(() => {
		if (ended) stopSpeech();
	}, [ended, stopSpeech]);

	return (
		<PaneFrame
			terminalId={terminal.id}
			name={terminal.name}
			title={title}
			theme={terminal.theme}
			focused={focused}
			ended={ended}
			alone={alone}
			dropEdge={dropEdge}
			moveTargets={moveTargets}
			onFocus={onFocus}
			onSplit={onSplit}
			onMoveToNewTab={onMoveToNewTab}
			onMoveInto={onMoveInto}
			onResetSizes={onResetSizes}
			onLeave={onLeave}
			onClose={onClose}
			onRename={onRename}
			onSetTheme={onSetTheme}
			voice={ended ? undefined : speech}
		>
			{ended ? (
				<div className="pk-term-ended" data-testid={`terminal-ended-${terminal.id}`}>
					<p className="pk-term-ended-text">
						This terminal ended when the workspace stopped
					</p>
					<Button
						variant="secondary"
						size="sm"
						data-testid="new-terminal-here"
						onClick={() => onReplace(terminal.id)}
					>
						New terminal here
					</Button>
				</div>
			) : (
				<TerminalPane
					workspaceId={workspaceId}
					projectId={projectId}
					terminal={terminal}
					visible={visible}
					focusOnMount={focused}
					onExited={onExited}
					onCwd={setLiveCwd}
					onFocus={onFocus}
					onLeave={onLeave}
					// Unsupported browsers (Firefox) keep Alt+Shift+M for the shell.
					onVoiceHold={
						speech.state === "unsupported"
							? undefined
							: (held) => (held ? speech.start() : speech.stop())
					}
					dictation={dictation}
				/>
			)}
		</PaneFrame>
	);
}
