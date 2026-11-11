/**
 * One tool call in the conversation: a light row that says what happened
 * ("Read a.ts", "Ran pnpm test", "Edited a.ts +1 −3"), with its state only
 * while it runs or when it failed or stopped. It opens to what it did and
 * what came back, leaving out what the row already says (SPEC.md §10.8). The
 * raw input stays one click further in. A background Agent launch shows a
 * plain status, a way into the subagent's own conversation, and its prompt;
 * the text Claude Code returns for the model stays behind Raw output (SPEC.md
 * §8.3). Images from a tool are drawn from
 * `data:` URLs, which the page's img-src allows (apps/web/src/csp.ts).
 */
import type { ChatToolOutputPart } from "@portikus/contracts";
import { agentStateWords, Icon, type IconName } from "@portikus/ui";
import { memo, useContext } from "react";
import { useAgentStatus } from "../terminal/codingAgentStatus.js";
import { CodeBlock, DiffBlock } from "./CodeBlocks.js";
import type { ChatToolItem } from "./chatStore.js";
import { useChatImages } from "./ImageViewer.js";
import { SubagentOpenerContext } from "./subagentView.js";
import { type ToolDetail, type ToolLine, toolLine } from "./toolView.js";

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

function Detail({ detail }: { detail: ToolDetail }) {
	switch (detail.kind) {
		case "command":
			return <CodeBlock text={detail.command} className="pk-chat-command" />;
		case "edit":
			return <DiffBlock changes={detail.changes} path={detail.path} />;
		case "write":
			return <CodeBlock text={detail.content} />;
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

/** What a background launch shows: its status and prompt, with Claude Code's own text kept closed. */
function LaunchBody({ tool }: { tool: ChatToolItem }) {
	const prompt = agentPrompt(tool.input);
	const openSubagent = useContext(SubagentOpenerContext);
	return (
		<>
			<LaunchStatus tool={tool} />
			{openSubagent ? (
				<button
					type="button"
					className="pk-chat-agent-open pk-focus-ring"
					data-testid="chat-agent-open"
					onClick={() => openSubagent({ toolUseId: tool.id, title: tool.title })}
				>
					Show its conversation
				</button>
			) : null}
			{prompt ? <CodeBlock text={prompt} limit={12} /> : null}
			{tool.output.length > 0 ? (
				<details className="pk-chat-raw">
					<summary className="pk-chat-raw-summary pk-focus-inset">
						<Icon name="chevron-right" size="sm" className="pk-chat-chevron" />
						Raw output
					</summary>
					{tool.output.map((part, at) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: parts only append
						<OutputPart key={at} part={part} tool={tool.name} />
					))}
				</details>
			) : null}
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

export const ToolBlock = memo(function ToolBlock({ tool }: { tool: ChatToolItem }) {
	const failed = tool.status === "error";
	const line = toolLine(tool.name, tool.input, tool.title);
	const detail = line.detail;
	// An edit or a write says nothing back; its diff or content is the result.
	const quiet = detail?.kind === "edit" || detail?.kind === "write";
	const launch = isBackgroundLaunch(tool);
	return (
		<details
			className={`pk-chat-tool${failed ? " is-error" : ""}`}
			data-testid={`chat-tool-${tool.id}`}
			data-status={tool.status}
		>
			<summary className="pk-chat-tool-summary pk-focus-inset">
				<Icon name={line.icon} size="sm" className="pk-chat-tool-icon" />
				<span className="pk-chat-tool-text">
					<span className="pk-chat-tool-verb">
						{line.verb
							? tool.status === "done"
								? line.verb.done
								: tool.status === "running"
									? line.verb.doing
									: line.verb.pending
							: tool.name}
					</span>
					{line.target ? (
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
				{launch ? (
					<LaunchBody tool={tool} />
				) : tool.output.length > 0 ? (
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
				) : quiet ? null : (
					<p className="pk-chat-muted">
						{tool.status === "running" ? "No output yet" : "No output"}
					</p>
				)}
				<details className="pk-chat-raw">
					<summary className="pk-chat-raw-summary pk-focus-inset">
						<Icon name="chevron-right" size="sm" className="pk-chat-chevron" />
						Raw input
					</summary>
					<CodeBlock text={JSON.stringify(tool.input, null, 2) ?? ""} limit={40} />
				</details>
			</div>
		</details>
	);
});
