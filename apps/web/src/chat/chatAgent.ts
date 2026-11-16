/**
 * Which coding agent a chat tab runs, so the conversation names it right: the
 * byline, a card's heading and the subagent view's note say "Codex" in a Codex
 * chat and "Claude" in a Claude one. The chat view provides it; a view drawn
 * outside one reads as Claude.
 */
import { CODING_AGENT_LABEL, type CodingAgent } from "@portikus/contracts";
import { createContext, useContext } from "react";
import { CODING_AGENT_NAME } from "../agents/codingAgentName.js";

export const ChatAgentContext = createContext<CodingAgent>("claude");

/**
 * A speaker that is not a coding agent, such as the administrators' built-in
 * assistant; when set, the conversation names it instead of the agent.
 */
export const ChatSpeakerContext = createContext<string | null>(null);

export interface ChatAgentNames {
	agent: CodingAgent;
	/** The agent as a speaker: "Claude", "Codex". */
	name: string;
	/** The program that runs it: "Claude Code", "Codex". */
	program: string;
}

export function useChatAgent(): ChatAgentNames {
	const agent = useContext(ChatAgentContext);
	const speaker = useContext(ChatSpeakerContext);
	return {
		agent,
		name: speaker ?? CODING_AGENT_LABEL[agent],
		program: speaker ?? CODING_AGENT_NAME[agent],
	};
}
