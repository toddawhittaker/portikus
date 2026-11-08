/**
 * One tool call in the conversation: a collapsed row with the tool, a short
 * summary and its state, that opens to what it did and what came back
 * (SPEC.md §10.8). The raw input stays one click further in. Images from a
 * tool are drawn from `data:` URLs, which the page's img-src allows
 * (apps/web/src/csp.ts).
 */
import type { ChatToolOutputPart } from "@portikus/contracts";
import { Icon, type IconName } from "@portikus/ui";
import { memo } from "react";
import { CodeBlock, DiffBlock } from "./CodeBlocks.js";
import type { ChatToolItem } from "./chatStore.js";
import { type ToolDetail, toolView } from "./toolView.js";

function OutputPart({ part, tool }: { part: ChatToolOutputPart; tool: string }) {
	switch (part.type) {
		case "text":
			return <CodeBlock text={part.text} />;
		case "image":
			return (
				<img
					className="pk-chat-tool-image"
					src={`data:${part.mediaType};base64,${part.data}`}
					alt={`Output of ${tool}`}
					decoding="async"
				/>
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
			return <DiffBlock changes={detail.changes} />;
		case "write":
			return <CodeBlock text={detail.content} />;
	}
}

/** Each state has a word and its own glyph, so colour is never the only sign. */
const STATE: Record<ChatToolItem["status"], { label: string; icon: IconName | null }> =
	{
		running: { label: "Running", icon: null },
		done: { label: "Done", icon: "check" },
		error: { label: "Failed", icon: "alert" },
		stopped: { label: "Stopped", icon: "stop" },
	};

function ToolState({ status }: { status: ChatToolItem["status"] }) {
	const state = STATE[status];
	return (
		<span className={`pk-chat-tool-state is-${status}`} data-testid="chat-tool-state">
			{status === "running" ? <span className="pk-spin" aria-hidden={true} /> : null}
			{state.icon ? <Icon name={state.icon} size="sm" /> : null}
			{state.label}
		</span>
	);
}

export const ToolBlock = memo(function ToolBlock({ tool }: { tool: ChatToolItem }) {
	const failed = tool.status === "error";
	const view = toolView(tool.name, tool.input, tool.title);
	return (
		<details
			className={`pk-chat-tool${failed ? " is-error" : ""}`}
			data-testid={`chat-tool-${tool.id}`}
			data-status={tool.status}
		>
			<summary className="pk-chat-tool-summary pk-focus-inset">
				<Icon name="chevron-right" size="sm" className="pk-chat-chevron" />
				<span className="pk-chat-tool-name">{tool.name}</span>
				{view.summary ? (
					<span
						className={`pk-chat-tool-title${view.literal ? " pk-mono-body" : ""}`}
						title={view.summary}
					>
						{view.summary}
					</span>
				) : null}
				<ToolState status={tool.status} />
			</summary>
			<div className="pk-chat-tool-body">
				{view.detail ? <Detail detail={view.detail} /> : null}
				{tool.output.length === 0 ? (
					<p className="pk-chat-muted">
						{tool.status === "running" ? "No output yet" : "No output"}
					</p>
				) : (
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
