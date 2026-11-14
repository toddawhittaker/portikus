/**
 * The notice an automatic handoff leaves in the conversation (SPEC.md §10.8):
 * the host saved a note while the student was away, before the prompt cache
 * went cold. The newest notice offers to start fresh from the note, as
 * Continue does, or to copy the prompt the fresh chat would get, which the
 * host reads from the note's file; an older one keeps only its words and
 * link. If the file changed since it was saved, either button shows the
 * review card instead, so the student sees what would be sent.
 */
import { Button, CONTROL_CLASS, Icon } from "@portikus/ui";
import { useContext, useEffect, useRef, useState } from "react";
import type { ChatAutoHandoffItem } from "./freshStart.js";
import { FreshStartContext } from "./HandoffDivider.js";
import "./handoff.css";

export const AUTO_HANDOFF_TEXT =
	"While you were away, Portikus saved a handoff note so your next message doesn't re-read this whole chat.";
export const START_FRESH_WITH_IT = "Start fresh with it";
export const COPY_PROMPT = "Copy prompt";
const COPIED = "Prompt copied.";
const NOT_COPIED = "Could not copy. The prompt is selected below; copy it from there.";

export function AutoHandoffNotice({ notice }: { notice: ChatAutoHandoffItem }) {
	const actions = useContext(FreshStartContext);
	const [said, setSaid] = useState("");
	const [manual, setManual] = useState(false);
	const [prompt, setPrompt] = useState("");
	const field = useRef<HTMLTextAreaElement | null>(null);

	useEffect(() => {
		if (!manual) return;
		field.current?.focus();
		field.current?.select();
	}, [manual]);

	async function copy() {
		setSaid("");
		const text = await actions?.copyPrompt(notice.id);
		if (!text) return;
		setPrompt(text);
		try {
			await navigator.clipboard.writeText(text);
			setManual(false);
			setSaid(COPIED);
		} catch {
			setManual(true);
			setSaid(NOT_COPIED);
		}
	}

	return (
		<li className="pk-chat-entry pk-chat-auto-handoff" data-testid="chat-auto-handoff">
			<p className="pk-text-caption pk-chat-auto-handoff-text">
				<Icon name="info" size="sm" />
				<span>
					{AUTO_HANDOFF_TEXT}{" "}
					{actions?.openNote ? (
						<button
							type="button"
							className="pk-chat-handoff-link pk-link"
							data-testid="chat-auto-handoff-note"
							onClick={() => actions.openNote?.(notice.path)}
						>
							{notice.path}
						</button>
					) : (
						<code>{notice.path}</code>
					)}
				</span>
			</p>
			{notice.superseded || !actions ? null : (
				<div className="pk-chat-auto-handoff-actions">
					<Button
						size="sm"
						data-testid="chat-auto-handoff-start"
						onClick={() => actions.startFresh(notice.id)}
					>
						{START_FRESH_WITH_IT}
					</Button>
					<Button
						size="sm"
						variant="secondary"
						data-testid="chat-auto-handoff-copy"
						onClick={() => void copy()}
					>
						{COPY_PROMPT}
					</Button>
				</div>
			)}
			{manual ? (
				<textarea
					ref={field}
					className={`${CONTROL_CLASS} pk-chat-auto-handoff-prompt`}
					readOnly={true}
					aria-label="Handoff prompt"
					data-testid="chat-auto-handoff-prompt"
					value={prompt}
				/>
			) : null}
			<p className="sr-only" role="status" data-testid="chat-auto-handoff-status">
				{said}
			</p>
		</li>
	);
}
