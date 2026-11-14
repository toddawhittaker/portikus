/**
 * Says, above the message box, that the student is not signed in to the
 * chat's agent, before a message fails for it (SPEC.md §10.8). It offers
 * the agent's own terminal, where the student signs in, and a way to ask
 * the agent again. Sending stays possible: the warning never blocks it.
 */
import type { CodingAgent } from "@portikus/contracts";
import { Button, Icon } from "@portikus/ui";
import { useState } from "react";
import { useStore } from "zustand";
import { agentTabName, CODING_AGENT_NAME } from "../agents/codingAgentName.js";
import type { ChatStore } from "./chatStore.js";
import "./sign-in.css";

export interface SignInBannerProps {
	store: ChatStore;
	agent: CodingAgent;
	/** Opens a new tab of the agent's terminal; absent outside a work area. */
	onOpenTerminal?: (() => void) | undefined;
}

export function SignInBanner({ store, agent, onOpenTerminal }: SignInBannerProps) {
	const checking = useStore(store, (state) => state.signInChecking);
	const [asked, setAsked] = useState(false);
	const [unsent, setUnsent] = useState(false);
	const name = CODING_AGENT_NAME[agent];
	const tab = agentTabName(agent, "terminal");

	function checkAgain() {
		const sent = store.getState().checkSignIn();
		setUnsent(!sent);
		setAsked(sent);
	}

	// The words change after a check, so a screen reader hears its answer.
	const body = unsent
		? "The check was not sent because the chat is not connected. Try again when it reconnects."
		: asked && !checking
			? `Still not signed in. Sign in from a ${tab} tab, then check again.`
			: `Sign in from a ${tab} tab, then check again. ${name} cannot answer until you do.`;

	return (
		<div
			className="pk-notice pk-notice--warning pk-chat-signin"
			data-testid="chat-sign-in"
		>
			<span className="pk-notice-icon">
				<Icon name="alert" size="md" />
			</span>
			<div className="pk-notice-main" role="status">
				<p className="pk-notice-title">You're not signed in to {name}.</p>
				<p className="pk-notice-body">{body}</p>
			</div>
			<div className="pk-notice-actions">
				{onOpenTerminal ? (
					<Button
						size="sm"
						data-testid="chat-sign-in-terminal"
						onClick={onOpenTerminal}
					>
						Open {tab}
					</Button>
				) : null}
				<Button
					size="sm"
					loading={checking}
					data-testid="chat-sign-in-check"
					onClick={checkAgain}
				>
					Check again
				</Button>
			</div>
		</div>
	);
}
