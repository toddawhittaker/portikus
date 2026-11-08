/**
 * The rules granted with "Always allow" for this chat session, each with a
 * way to take it back (SPEC.md §10.8). Hidden while there are none.
 */
import { Button } from "@portikus/ui";
import { useState } from "react";
import { useStore } from "zustand";
import type { ChatStore } from "./chatStore.js";
import "./permissions.css";

export function SessionRules({ store }: { store: ChatStore }) {
	const rules = useStore(store, (state) => state.sessionRules);
	const [error, setError] = useState("");
	if (rules.length === 0) return null;
	const count = rules.length === 1 ? "1 rule" : `${rules.length} rules`;

	function revoke(rule: string) {
		setError(
			store.getState().revokeRule(rule)
				? ""
				: "The rule was not revoked because the chat is not connected. Try again when it reconnects.",
		);
	}

	return (
		<details className="pk-chat-rules" data-testid="chat-session-rules">
			<summary className="pk-focus-ring">
				Allowed without asking in this session: {count}
			</summary>
			<ul>
				{rules.map((held) => (
					<li key={held.rule} data-testid="chat-session-rule">
						<span className="pk-chat-rules-text">
							<span>{held.description}</span>
							<code className="pk-mono-body">{held.rule}</code>
						</span>
						<Button
							size="sm"
							aria-label={`Revoke: ${held.description}`}
							onClick={() => revoke(held.rule)}
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
	);
}
