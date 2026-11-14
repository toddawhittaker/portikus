/**
 * One tool call in the conversation: a light row that says what happened
 * ("Read a.ts", "Ran pnpm test", "Edited a.ts +1 −3"), with its state only
 * while it runs or when it failed or stopped. It opens to what it did and
 * what came back, leaving out what the row already says (SPEC.md §10.8). The
 * raw input stays one click further in, except where the opened row already
 * shows it (an MCP call's arguments). Codex's items read in the same rows: a
 * command by what it did, a file change as one diff per file, an MCP call as
 * Claude's is. An Agent card has neither raw disclosure: a background launch
 * shows a plain status and its prompt, and the text Claude Code returns for
 * the model is never shown. Every Agent call, and every Codex subagent call
 * that names a child, offers a way into its subagent's own conversation
 * (SPEC.md §8.3). Images from a tool are drawn from `data:` URLs, which the
 * page's img-src allows (apps/web/src/csp.ts).
 */
import type { ChatToolOutputPart } from "@portikus/contracts";
import { agentStateWords, Icon, type IconName } from "@portikus/ui";
import { memo, useContext, useId } from "react";
import { useAgentStatus } from "../terminal/codingAgentStatus.js";
import { CodeBlock, DiffBlock } from "./CodeBlocks.js";
import type { ChatToolItem } from "./chatStore.js";
import { useChatImages } from "./ImageViewer.js";
import { PlanText } from "./PermissionCard.js";
import { SubagentOpenerContext } from "./subagentView.js";
import {
	collabReceivers,
	type FileChangeView,
	type PlanStepView,
	type ToolDetail,
	type ToolLine,
	toolLine,
} from "./toolView.js";

/** A tool's image opens large in the viewer, like an image in a reply. */
function ToolImage({ src, tool }: { src: string; tool: string }) {
	const images = useChatImages();
	const alt = `Output of ${tool}`;
	const image = (
		<img className="pk-chat-tool-image" src={src} alt={alt} decoding="async" />
	);
	if (images === null) return image;
	return (
		<button
			type="button"
			className="pk-chat-image"
			aria-label={`View image ${alt}`}
			onClick={() => images.open({ src, name: alt, alt })}
		>
			{image}
		</button>
	);
}

function OutputPart({ part, tool }: { part: ChatToolOutputPart; tool: string }) {
	switch (part.type) {
		case "text":
			return <CodeBlock text={part.text} copyLabel="Copy output" />;
		case "image":
			return (
				<ToolImage src={`data:${part.mediaType};base64,${part.data}`} tool={tool} />
			);
		case "imageOmitted":
			return <p className="pk-chat-muted">Image not kept</p>;
	}
}

const FILE_CHANGE_WORD = {
	add: "Created",
	delete: "Deleted",
	update: "Edited",
	move: "Moved",
} as const;

/**
 * A file a call changed, headed by its name and drawn as its diff. The group
 * is named by its path line, which says in words what happened to the file;
 * it is not a region, so a long change does not fill the landmark list.
 */
function FileChange({ file }: { file: FileChangeView }) {
	const pathId = useId();
	return (
		// biome-ignore lint/a11y/useSemanticElements: a fieldset is a form control's group; this names a file's diff
		<div role="group" aria-labelledby={pathId}>
			<p id={pathId} className="pk-chat-tool-path pk-mono-body">
				<span className="sr-only">{FILE_CHANGE_WORD[file.kind]} </span>
				{file.movePath ? `${file.path} \u2192 ${file.movePath}` : file.path}
			</p>
			<DiffBlock lines={file.lines} path={file.movePath ?? file.path} />
		</div>
	);
}

const STEP_WORD: Record<PlanStepView["state"], string> = {
	done: "Done",
	inProgress: "In progress",
	todo: "To do",
};

/** A plan's steps as a list, each with its state in words. */
function PlanSteps({ steps }: { steps: PlanStepView[] }) {
	return (
		<ol className="pk-chat-steps">
			{steps.map((step, at) => (
				// A plan's steps keep their order, so position is their identity.
				// biome-ignore lint/suspicious/noArrayIndexKey: see above
				<li key={at} className={`is-${step.state}`}>
					<span className="pk-chat-step-state">{STEP_WORD[step.state]}</span>{" "}
					{step.step}
				</li>
			))}
		</ol>
	);
}

function Detail({ detail }: { detail: ToolDetail }) {
	switch (detail.kind) {
		case "command":
			return <CodeBlock text={detail.command} className="pk-chat-command" />;
		case "edit":
			return <DiffBlock changes={detail.changes} path={detail.path} />;
		case "write":
			return <CodeBlock text={detail.content} />;
		case "files":
			return detail.files.map((file) => <FileChange key={file.path} file={file} />);
		case "arguments":
			return (
				<CodeBlock text={JSON.stringify(detail.value, null, 2) ?? ""} limit={40} />
			);
		case "steps":
			return <PlanSteps steps={detail.steps} />;
		case "markdown":
			return <PlanText text={detail.text} />;
	}
}

/** Each state shown has a word and its own glyph, so colour is never the only sign. */
const STATE: Record<
	Exclude<ChatToolItem["status"], "done">,
	{ label: string; icon: IconName | null }
> = {
	running: { label: "Running", icon: null },
	error: { label: "Failed", icon: "alert" },
	stopped: { label: "Stopped", icon: "stop" },
};

function ToolState({
	status,
	verbSaysIt,
}: {
	status: ChatToolItem["status"];
	/** The row's verb already tells the state: "Ran", or "Running pnpm test". */
	verbSaysIt: boolean;
}) {
	if (status === "done") return null;
	const state = STATE[status];
	return (
		<span className={`pk-chat-tool-state is-${status}`} data-testid="chat-tool-state">
			{status === "running" ? <span className="pk-spin" aria-hidden={true} /> : null}
			{state.icon ? <Icon name={state.icon} size="sm" /> : null}
			{status === "running" && verbSaysIt ? null : state.label}
		</span>
	);
}

/** How Claude Code's text for the model begins when a background Agent call starts. */
const LAUNCH_TEXT = "Async agent launched";

/** A background subagent call that is starting or started; a failed one shows its error like any tool. */
function isBackgroundLaunch(tool: ChatToolItem): boolean {
	if (tool.name !== "Agent") return false;
	const first = tool.output[0];
	const launched = first?.type === "text" && first.text.startsWith(LAUNCH_TEXT);
	if (tool.status === "running") {
		const input = tool.input as { run_in_background?: unknown } | null;
		return launched || input?.run_in_background === true;
	}
	return tool.status === "done" && launched;
}

/** The subagent's state is the one the project list shows for the same tool call. */
function LaunchStatus({ tool }: { tool: ChatToolItem }) {
	const { terminals } = useAgentStatus();
	const state = terminals
		.flatMap((terminal) => terminal.subagents)
		.find((subagent) => subagent.id === tool.id)?.state;
	const text =
		tool.status === "running"
			? "Starting in the background"
			: `Started in the background${state ? ` · ${agentStateWords(state)}` : ""}`;
	return (
		<p className="pk-chat-muted" data-testid="chat-agent-status">
			{text}
		</p>
	);
}

function agentPrompt(input: unknown): string | null {
	const prompt = (input as { prompt?: unknown } | null)?.prompt;
	return typeof prompt === "string" && prompt !== "" ? prompt : null;
}

/**
 * The way into a subagent's own conversation, on any Agent call, foreground
 * or background, except one that failed before a subagent started. A Codex
 * subagent tool names its children by thread id, and each opens by that id.
 */
function WatchSubagent({ tool, titleId }: { tool: ChatToolItem; titleId: string }) {
	const openSubagent = useContext(SubagentOpenerContext);
	if (!openSubagent || tool.status === "error") return null;
	if (tool.name === "Agent") {
		return (
			<OpenButton
				label="Show its conversation"
				titleId={titleId}
				onOpen={() => openSubagent({ toolUseId: tool.id, title: tool.title })}
			/>
		);
	}
	if (tool.name !== "collabAgentToolCall") return null;
	const children = collabReceivers(tool.input);
	return children.map((child, at) => (
		<OpenButton
			key={child}
			label={
				children.length === 1
					? "Show its conversation"
					: `Show subagent ${at + 1}'s conversation`
			}
			titleId={titleId}
			onOpen={() =>
				openSubagent({
					toolUseId: child,
					// Numbered as the row numbers its buttons, so panels tell apart.
					title: children.length === 1 ? SUBAGENT_TITLE : `${SUBAGENT_TITLE} ${at + 1}`,
				})
			}
		/>
	));
}

/** A Codex subagent has no description, so its view is named by what it is. */
const SUBAGENT_TITLE = "Subagent";

function OpenButton({
	label,
	titleId,
	onOpen,
}: {
	label: string;
	titleId: string;
	onOpen: () => void;
}) {
	return (
		<button
			type="button"
			className="pk-chat-agent-open pk-focus-ring"
			data-testid="chat-agent-open"
			// Every card's button reads the same; its card's title tells them apart.
			aria-describedby={titleId}
			onClick={onOpen}
		>
			{label}
		</button>
	);
}

/** What a background launch shows: its status and prompt, never Claude Code's own text. */
function LaunchBody({ tool }: { tool: ChatToolItem }) {
	const prompt = agentPrompt(tool.input);
	return (
		<>
			<LaunchStatus tool={tool} />
			{prompt ? <CodeBlock text={prompt} limit={12} /> : null}
		</>
	);
}

const lines = (count: number) => `${count} ${count === 1 ? "line" : "lines"}`;

/** "+1 −3" to the eye; spelled out for a screen reader. */
function EditStat({ line }: { line: ToolLine }) {
	if (line.added === 0 && line.removed === 0) return null;
	return (
		<span className="pk-chat-tool-stat pk-mono-body">
			<span aria-hidden={true}>
				<span className="is-added">+{line.added}</span>{" "}
				<span className="is-removed">−{line.removed}</span>
			</span>
			<span className="sr-only">
				{`, ${lines(line.added)} added, ${lines(line.removed)} removed`}
			</span>
		</span>
	);
}

/** The verb in the tense the call is in, or the tool's own name when it has none. */
function verbText(tool: ChatToolItem, line: ToolLine): string {
	if (!line.verb) return tool.name;
	if (tool.status === "done") return line.verb.done;
	return tool.status === "running" ? line.verb.doing : line.verb.pending;
}

export const ToolBlock = memo(function ToolBlock({ tool }: { tool: ChatToolItem }) {
	const failed = tool.status === "error";
	const line = toolLine(tool.name, tool.input, tool.title);
	const detail = line.detail;
	// What the opened row shows already is the tool's input.
	const showsInput =
		detail?.kind === "arguments" || tool.name === "Agent" || tool.name === "plan";
	// An edit, a write or a file change says nothing back; its diff or content is the result.
	const quiet =
		detail?.kind === "edit" ||
		detail?.kind === "write" ||
		detail?.kind === "files" ||
		detail?.kind === "steps" ||
		detail?.kind === "markdown";
	const launch = isBackgroundLaunch(tool);
	const titleId = useId();

	function outputBody() {
		if (launch) return <LaunchBody tool={tool} />;
		if (tool.output.length > 0) {
			return (
				<section
					className="pk-chat-tool-output"
					aria-label={failed ? "Error" : "Output"}
				>
					{tool.output.map((part, at) => (
						// Parts only ever append, so their order is their identity.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above
						<OutputPart key={at} part={part} tool={tool.name} />
					))}
				</section>
			);
		}
		if (quiet) return null;
		return (
			<p className="pk-chat-muted">
				{tool.status === "running" ? "No output yet" : "No output"}
			</p>
		);
	}

	return (
		<details
			className={`pk-chat-tool${failed ? " is-error" : ""}`}
			data-testid={`chat-tool-${tool.id}`}
			data-status={tool.status}
		>
			<summary className="pk-chat-tool-summary pk-focus-inset">
				<Icon name={line.icon} size="sm" className="pk-chat-tool-icon" />
				<span className="pk-chat-tool-text" id={titleId}>
					<span className="pk-chat-tool-verb">{verbText(tool, line)}</span>
					{line.target && line.target !== verbText(tool, line) ? (
						<>
							{" "}
							<span
								className={`pk-chat-tool-title${line.literal ? " pk-mono-body" : ""}`}
								title={line.path ?? line.target}
							>
								{line.target}
							</span>
						</>
					) : null}
				</span>
				<EditStat line={line} />
				<Icon name="chevron-right" size="sm" className="pk-chat-chevron" />
				<ToolState status={tool.status} verbSaysIt={line.verb !== null} />
			</summary>
			<div className="pk-chat-tool-body">
				{line.path ? (
					<p className="pk-chat-tool-path pk-mono-body">{line.path}</p>
				) : null}
				{detail ? <Detail detail={detail} /> : null}
				<WatchSubagent tool={tool} titleId={titleId} />
				{outputBody()}
				{showsInput ? null : (
					<details className="pk-chat-raw">
						<summary className="pk-chat-raw-summary pk-focus-inset">
							<Icon name="chevron-right" size="sm" className="pk-chat-chevron" />
							Raw input
						</summary>
						<CodeBlock text={JSON.stringify(tool.input, null, 2) ?? ""} limit={40} />
					</details>
				)}
			</div>
		</details>
	);
});
