/**
 * One terminal pane inside a split: the pane frame around the terminal
 * itself (SPEC.md §9.3). A terminal ended by a workspace stop keeps its
 * place and offers a new one (SPEC.md §6.8).
 */
import {
	MAX_UPLOAD_BYTES,
	type Terminal,
	type TerminalTheme,
} from "@portikus/contracts";
import { Button, Skeleton, useToast } from "@portikus/ui";
import {
	type DragEvent,
	lazy,
	type ReactNode,
	Suspense,
	useEffect,
	useRef,
	useState,
} from "react";
import { fileErrorToast, tooLargeToast } from "../files/errors.js";
import { displayName } from "../files/paths.js";
import "../chat/chat-frame.css";
import { saveDroppedFile } from "../files/queries.js";
import { draggedTreeNodes } from "../files/treeDrag.js";
import type { DropEdge, SplitDirection } from "../layout/tree.js";
import { useProjects } from "../projects/queries.js";
import { useSpeechInput } from "../voice/useSpeechInput.js";
import { dropZone } from "../work/dropZone.js";
import { agentLabel } from "./agentLabel.js";
import { PaneFrame } from "./PaneFrame.js";
import { TerminalPane } from "./TerminalPane.js";
import {
	type DropKind,
	dropKind,
	dropNameError,
	dropPaths,
	droppedPathsInput,
} from "./terminalDrop.js";

// Markdown rendering loads only when a chat tab opens (SPEC.md §25.1).
const ChatView = lazy(() =>
	import("../chat/ChatView.js").then((module) => ({ default: module.ChatView })),
);

export interface TerminalLeafProps {
	workspaceId: string;
	projectId: string;
	terminal: Terminal;
	visible: boolean;
	focused: boolean;
	onFocus: (terminalId: string) => void;
	/** What Split right and Split down offer to open. */
	splitItems: (terminalId: string, direction: SplitDirection) => ReactNode;
	onRename: (terminalId: string, name: string) => void;
	/** Switch this one terminal between the light and dark scheme. */
	onSetTheme: (terminalId: string, theme: TerminalTheme) => void;
	onClose: (terminalId: string) => void;
	onExited: (terminalId: string) => void;
	onReplace: (terminalId: string) => void;
	/** Continue an ended chat's Claude session in a new chat in its place (SPEC.md §10.8). */
	onResume: (terminalId: string) => void;
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
	splitItems,
	onRename,
	onSetTheme,
	onClose,
	onExited,
	onReplace,
	onResume,
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
	const chat = terminal.kind === "chat";
	// An agent's pane is named as its tab is, so a chat never reads "Terminal 3".
	const name = agentLabel(terminal) ?? terminal.name;
	const title = `${name} · ${shortenPath(liveCwd)}`;
	// Voice input types into this pane's terminal through the ref it fills.
	const dictation = useRef<((text: string) => void) | null>(null);
	const speech = useSpeechInput((text) => dictation.current?.(text));
	const toast = useToast();
	const projects = useProjects(workspaceId, "active");
	const projectSlug = projects.data?.find((project) => project.id === projectId)?.slug;
	const dropHost = useRef<HTMLDivElement | null>(null);
	const [dropActive, setDropActive] = useState(false);
	const stopSpeech = speech.stop;
	// A terminal that ends mid-dictation must not keep the microphone open.
	useEffect(() => {
		if (ended) stopSpeech();
	}, [ended, stopSpeech]);

	/**
	 * What a drag over the terminal would do, or null when it does nothing.
	 * Desktop files drop anywhere on the terminal; a tree row drops only on the
	 * middle, because its edges split the pane (SPEC.md §9.3, §9.6).
	 */
	function acceptedKind(event: DragEvent): DropKind | null {
		const kind = dropKind(event.dataTransfer.types);
		if (kind !== "tree") return kind;
		// Page content can forge the drag type; only a real tree drag counts.
		if (draggedTreeNodes().length === 0) return null;
		const pane = dropHost.current?.closest("section");
		if (!pane) return null;
		const zone = dropZone(pane.getBoundingClientRect(), event.clientX, event.clientY);
		return zone === "center" ? kind : null;
	}

	function onDragOver(event: DragEvent) {
		const kind = acceptedKind(event);
		setDropActive(kind !== null);
		if (kind === null) return;
		event.preventDefault();
		// A dragged row only allows a move, so a copy would be refused.
		event.dataTransfer.dropEffect = kind === "tree" ? "move" : "copy";
	}

	function onDragLeave(event: DragEvent) {
		const next = event.relatedTarget;
		if (next instanceof Node && dropHost.current?.contains(next)) return;
		setDropActive(false);
	}

	/** Type the paths of `relative` project paths at the cursor, without Enter. */
	function typePaths(relative: readonly string[]) {
		const text = projectSlug ? droppedPathsInput(projectSlug, relative) : null;
		if (text === null) {
			toast.show({
				tone: "danger",
				title: "That path cannot be typed into a terminal",
				children: "Rename it without special characters, then try again.",
			});
			return;
		}
		dictation.current?.(text);
	}

	/** Save each desktop file in the project, then type where they went. */
	async function dropFiles(files: File[]) {
		if (files.length === 0) return;
		for (const file of files) {
			const bad = dropNameError(file.name);
			if (bad) {
				toast.show({
					tone: "danger",
					title: `${displayName(file.name)} cannot be dropped`,
					children: bad,
				});
				return;
			}
			if (file.size > MAX_UPLOAD_BYTES) {
				toast.show(tooLargeToast());
				return;
			}
		}
		if (!projectSlug) {
			toast.show(fileErrorToast(null));
			return;
		}
		const now = new Date();
		try {
			const saved: string[] = [];
			for (const file of files) {
				saved.push(
					await saveDroppedFile(
						workspaceId,
						projectId,
						dropPaths(now, file.name),
						file,
					),
				);
			}
			typePaths(saved);
		} catch (error) {
			toast.show(fileErrorToast(error));
		}
	}

	function onDrop(event: DragEvent) {
		const kind = acceptedKind(event);
		setDropActive(false);
		if (kind === null) return;
		event.preventDefault();
		event.stopPropagation();
		if (kind === "files") {
			// The list empties once the handler returns.
			void dropFiles(Array.from(event.dataTransfer.files));
			return;
		}
		const paths = draggedTreeNodes().map((node) => node.path);
		if (paths.length > 0) typePaths(paths);
	}

	return (
		<PaneFrame
			terminalId={terminal.id}
			name={name}
			title={title}
			theme={terminal.theme}
			focused={focused}
			ended={ended}
			alone={alone}
			dropEdge={dropEdge}
			moveTargets={moveTargets}
			onFocus={onFocus}
			splitItems={splitItems}
			onMoveToNewTab={onMoveToNewTab}
			onMoveInto={onMoveInto}
			onResetSizes={onResetSizes}
			onLeave={onLeave}
			onClose={onClose}
			onRename={onRename}
			// A chat follows the page's theme, and its composer holds the microphone.
			onSetTheme={chat ? undefined : onSetTheme}
			voice={ended || chat ? undefined : speech}
			chat={chat}
		>
			{ended ? (
				<div className="pk-term-ended" data-testid={`terminal-ended-${terminal.id}`}>
					<p className="pk-term-ended-text">
						{chat
							? "This chat ended when the workspace stopped"
							: "This terminal ended when the workspace stopped"}
					</p>
					<div className="pk-term-ended-actions">
						{chat ? (
							<Button
								variant="primary"
								size="sm"
								data-testid="chat-resume"
								onClick={() => onResume(terminal.id)}
							>
								Resume chat
							</Button>
						) : null}
						<Button
							variant="secondary"
							size="sm"
							data-testid="new-terminal-here"
							onClick={() => onReplace(terminal.id)}
						>
							New terminal here
						</Button>
					</div>
				</div>
			) : chat ? (
				<Suspense fallback={<ChatLoading />}>
					<ChatView
						workspaceId={workspaceId}
						projectId={projectId}
						terminalId={terminal.id}
						visible={visible}
						focused={focused}
						onLeave={onLeave}
					/>
				</Suspense>
			) : (
				// `contents` keeps the wrapper out of the layout, so the pane
				// sizes as before; its drag events still bubble through it.
				// biome-ignore lint/a11y/noStaticElementInteractions: a drop area; pasting a picture is the keyboard way
				<div
					ref={dropHost}
					style={{ display: "contents" }}
					onDragOver={onDragOver}
					onDragLeave={onDragLeave}
					onDrop={onDrop}
				>
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
					{dropActive ? (
						<div
							className="pk-term-drop pk-term-drop--center"
							data-testid={`file-drop-target-${terminal.id}`}
							aria-hidden="true"
						/>
					) : null}
				</div>
			)}
		</PaneFrame>
	);
}

/** Holds the chat's place while its code loads, so nothing jumps. */
function ChatLoading() {
	return (
		<div className="pk-chat pk-term-screen" data-testid="chat-view-loading">
			<Skeleton lines={3} width="60%" />
		</div>
	);
}
