/**
 * One tool call in the conversation: a collapsed row with its name and title
 * that opens to its input and output (SPEC.md §10.8). Images from a tool are
 * drawn from `data:` URLs, which the page's img-src allows (apps/web/src/csp.ts).
 */
import type { ChatToolOutputPart } from "@portikus/contracts";
import { Icon } from "@portikus/ui";
import { memo } from "react";
import type { ChatToolItem } from "./chatStore.js";

function formatInput(input: unknown): string {
	return JSON.stringify(input, null, 2) ?? "";
}

function OutputPart({ part, tool }: { part: ChatToolOutputPart; tool: string }) {
	switch (part.type) {
		case "text":
			return (
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling box must be reachable by keyboard
				<pre className="pk-chat-code" tabIndex={0}>
					{part.text}
				</pre>
			);
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

export const ToolBlock = memo(function ToolBlock({ tool }: { tool: ChatToolItem }) {
	const failed = tool.status === "error";
	return (
		<details
			className={`pk-chat-tool${failed ? " is-error" : ""}`}
			data-testid={`chat-tool-${tool.id}`}
			data-status={tool.status}
		>
			<summary className="pk-chat-tool-summary pk-focus-inset">
				<Icon name="chevron-right" size="sm" className="pk-chat-chevron" />
				<span className="pk-chat-tool-name pk-mono-body">{tool.name}</span>
				{tool.title ? <span className="pk-chat-tool-title">{tool.title}</span> : null}
				{tool.status === "running" ? (
					<span className="pk-chat-tool-state">
						<span className="pk-spin" aria-hidden={true} />
						Running
					</span>
				) : failed ? (
					<span className="pk-chat-tool-state pk-chat-tool-state--error">
						<Icon name="alert" size="sm" />
						Failed
					</span>
				) : null}
			</summary>
			<dl className="pk-chat-tool-body">
				<dt className="pk-text-label pk-chat-label">Input</dt>
				<dd className="pk-chat-tool-part">
					{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling box must be reachable by keyboard */}
					<pre className="pk-chat-code" tabIndex={0}>
						{formatInput(tool.input)}
					</pre>
				</dd>
				<dt className="pk-text-label pk-chat-label">{failed ? "Error" : "Output"}</dt>
				<dd className="pk-chat-tool-part">
					{tool.output.length === 0 ? (
						<p className="pk-chat-muted">
							{tool.status === "running" ? "No output yet" : "No output"}
						</p>
					) : (
						tool.output.map((part, at) => (
							// Parts only ever append, so their order is their identity.
							// biome-ignore lint/suspicious/noArrayIndexKey: see above
							<OutputPart key={at} part={part} tool={tool.name} />
						))
					)}
				</dd>
			</dl>
		</details>
	);
});
