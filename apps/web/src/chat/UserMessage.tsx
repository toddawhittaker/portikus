/**
 * What the student wrote, and the files they sent with it (SPEC.md §10.8).
 * The first message of a chat started fresh from a handoff note was sent by
 * Portikus, so it says so.
 */
import { chatImageType, isHandoffFirstMessage } from "@portikus/contracts";
import { Icon } from "@portikus/ui";
import { useState } from "react";
import { displayName } from "../files/paths.js";
import { ChatMarkdown } from "./ChatMarkdown.js";
import { CopyButton } from "./CopyButton.js";
import { useChatAgent } from "./chatAgent.js";
import type { ChatMessageItem } from "./chatStore.js";
import { useChatImages } from "./ImageViewer.js";

/**
 * A file the student sent. A picture shows as a thumbnail that opens large in
 * the viewer; anything else, or a picture that will not load, is its path.
 */
function SentFile({ path }: { path: string }) {
	const images = useChatImages();
	const [failed, setFailed] = useState(false);
	const name = displayName(path.slice(path.lastIndexOf("/") + 1));
	if (images === null || failed || chatImageType(path) === null) {
		return (
			<li className="pk-chat-attachment">
				<Icon name="file" size="sm" />
				<span className="pk-chat-attachment-name">{displayName(path)}</span>
			</li>
		);
	}
	const src = images.imageUrl(path);
	return (
		<li className="pk-chat-attachment pk-chat-sent-image">
			<button
				type="button"
				className="pk-chat-image pk-chat-thumb"
				aria-label={`View image ${name}`}
				onClick={() => images.open({ src, name, alt: name, projectPath: path })}
			>
				<img
					src={src}
					alt={name}
					width={56}
					height={56}
					loading="lazy"
					onError={() => setFailed(true)}
				/>
			</button>
			<span className="pk-chat-attachment-name" title={displayName(path)}>
				{name}
			</span>
		</li>
	);
}

/** What the student wrote, drawn as the Markdown the composer sent (SPEC.md §10.8). */
export function UserMessage({ message }: { message: ChatMessageItem }) {
	const { name } = useChatAgent();
	const fromHandoff = isHandoffFirstMessage(message.markdown);
	return (
		<li
			className="pk-chat-entry pk-chat-entry--user pk-chat-copy-host"
			data-testid="chat-user-message"
		>
			<p className="sr-only">{fromHandoff ? "Portikus sent for you:" : "You said:"}</p>
			{message.markdown !== "" ? (
				<CopyButton label="Copy message" text={message.markdown} />
			) : null}
			<div className="pk-chat-bubble">
				{message.markdown !== "" ? <ChatMarkdown text={message.markdown} /> : null}
				{message.attachments.length > 0 ? (
					<ul className="pk-chat-attachments" aria-label="Attached files">
						{message.attachments.map((file) => (
							<SentFile key={file.path} path={file.path} />
						))}
					</ul>
				) : null}
			</div>
			{fromHandoff ? (
				<p className="pk-turn-sent-note" data-testid="chat-sent-by-portikus">
					Sent by Portikus from the handoff
				</p>
			) : null}
			{message.whileWorking ? (
				<p className="pk-turn-sent-note" data-testid="chat-sent-while-working">
					Sent while {name} was working
				</p>
			) : null}
		</li>
	);
}
