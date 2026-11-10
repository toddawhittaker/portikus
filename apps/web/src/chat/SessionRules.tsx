/**
 * The rules granted with "Always allow" for this chat session, each with a
 * way to take it back (SPEC.md §10.8). Hidden while there are none.
 */
import type { ChatSessionRule } from "@portikus/contracts";
import { Button } from "@portikus/ui";
import { useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { ChatStore } from "./chatStore.js";
import "./permissions.css";

export function SessionRules({ store }: { store: ChatStore }) {
	const rules = useStore(store, (state) => state.sessionRules);
	const [error, setError] = useState("");
	/**
	 * The rule whose revoke waits for the host, and the list it was asked
	 * against. Its button is busy until the host sends a new list.
	 */
	const [pending, setPending] = useState<{
		held: ChatSessionRule;
		asked: ChatSessionRule[];
	} | null>(null);
	const [said, setSaid] = useState("");
	const list = useRef<HTMLDetailsElement | null>(null);
	const holder = useRef<HTMLSpanElement | null>(null);
	/** Where the revoked row was, and whether it held the keyboard, read before the row goes. */
	const leaving = useRef<{ index: number; focused: boolean } | null>(null);

	if (pending && rules !== pending.asked) {
		setPending(null);
		// A list that still holds the rule means the host kept it; its error comes as a chat error.
		if (!rules.some((held) => held.rule === pending.held.rule)) {
			setSaid(`Revoked: ${pending.held.description}.`);
		}
	}

	// A control removed by its own action hands the keyboard on (SPEC.md §25.8).
	useLayoutEffect(() => {
		const from = leaving.current;
		if (from === null || pending !== null) return;
		leaving.current = null;
		if (!from.focused) return;
		const buttons = list.current?.querySelectorAll<HTMLElement>("li button");
		const target =
			buttons?.[from.index] ??
			list.current?.querySelector<HTMLElement>("summary") ??
			holder.current
				?.closest(".pk-chat")
				?.querySelector<HTMLElement>('[role="combobox"]');
		target?.focus({ preventScroll: true });
	}, [pending]);

	function revoke(held: ChatSessionRule, index: number, button: HTMLElement) {
		if (!store.getState().revokeRule(held.rule)) {
			setError(
				"The rule was not revoked because the chat is not connected. Try again when it reconnects.",
			);
			return;
		}
		setError("");
		setSaid("");
		leaving.current = { index, focused: document.activeElement === button };
		setPending({ held, asked: rules });
	}

	const count = rules.length === 1 ? "1 rule" : `${rules.length} rules`;
	return (
		<>
			{rules.length > 0 ? (
				<details ref={list} className="pk-chat-rules" data-testid="chat-session-rules">
					<summary className="pk-focus-ring">
						Allowed without asking in this session: {count}
					</summary>
					<ul>
						{rules.map((held, index) => (
							<li key={held.rule} data-testid="chat-session-rule">
								<span className="pk-chat-rules-text">
									<span>{held.description}</span>
									<code className="pk-mono-body">{held.rule}</code>
								</span>
								<Button
									size="sm"
									aria-label={`Revoke: ${held.description}`}
									loading={pending?.held.rule === held.rule}
									onClick={(event) => revoke(held, index, event.currentTarget)}
								>
									Revoke
								</Button>
							</li>
						))}
					</ul>
					<p className="pk-chat-rules-error" role="alert">
						{error}
					</p>
				</details>
			) : null}
			{/* Always mounted, so the confirmation is read even when the list goes with it. */}
			<span
				ref={holder}
				className="sr-only"
				role="status"
				data-testid="chat-session-rules-status"
			>
				{said}
			</span>
		</>
	);
}
