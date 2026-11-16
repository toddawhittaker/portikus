/**
 * The assistant's server calls and its conversation socket. The socket
 * speaks the student chat's wire events (packages/contracts assistant.ts),
 * so the chat store reads them as they are.
 */
import {
	AssistantClientMessage,
	AssistantStatus,
	type AssistantUnavailableReason,
	ConversationList,
	ConversationSummary,
	type CreateConversationRequest,
} from "@portikus/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";
import { ApiError, request, sendJson } from "../api/request.js";
import {
	type ChatStore,
	type ChatTransport,
	createChatStore,
} from "../chat/chatStore.js";
import { connectChatStore } from "../chat/connectChatStore.js";

const CONVERSATIONS = ["assistant", "conversations"];
const STATUS = ["assistant", "status"];

function conversationSocketPath(id: string): string {
	return `/assistant/conversations/${id}/socket`;
}

/** Newest first, by last use. */
function newestFirst(
	conversations: readonly ConversationSummary[],
): ConversationSummary[] {
	return [...conversations].sort((a, b) =>
		b.lastActiveAt.localeCompare(a.lastActiveAt),
	);
}

/** Only the caller's own conversations come back (SPEC.md section 24). */
export function useConversations(enabled: boolean) {
	return useQuery({
		queryKey: CONVERSATIONS,
		queryFn: async () =>
			newestFirst(
				(await request(ConversationList, "/assistant/conversations")).conversations,
			),
		enabled,
	});
}

export function useCreateConversation() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (body: CreateConversationRequest) =>
			sendJson(ConversationSummary, "/assistant/conversations", body),
		onSettled: () => client.invalidateQueries({ queryKey: CONVERSATIONS }),
	});
}

export function useDeleteConversation() {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (id: string) =>
			request(z.undefined(), `/assistant/conversations/${id}`, { method: "DELETE" }),
		onSettled: () => client.invalidateQueries({ queryKey: CONVERSATIONS }),
	});
}

export function useAssistantStatus(enabled: boolean) {
	return useQuery({
		queryKey: STATUS,
		queryFn: () => request(AssistantStatus, "/assistant/status"),
		enabled,
	});
}

/** The plain line for each reason the assistant cannot be used. */
const NOT_ENABLED_TEXT: Record<AssistantUnavailableReason, string> = {
	off: "The assistant is turned off for this site.",
	incomplete: "The assistant is not set up yet, so it cannot answer.",
	"no-key": "The assistant has no AI key yet, so it cannot answer.",
	"key-unreadable":
		"The assistant's AI key needs to be entered again, so it cannot answer.",
	notice:
		"The assistant waits for an administrator to accept the notice about what it sends.",
	"monthly-cap":
		"The assistant has used this month's token allowance. It works again next month.",
};

export function notEnabledText(status: AssistantStatus): string {
	return status.reason ? NOT_ENABLED_TEXT[status.reason] : NOT_ENABLED_TEXT.off;
}

/** The server refuses to start a conversation this way when the assistant was turned off since the status check. */
export function isNotEnabled(error: unknown): boolean {
	return error instanceof ApiError && error.code === "AI_NOT_ENABLED";
}

export interface AssistantConversation {
	store: ChatStore;
	/** Answers an approval card, with the typed confirmation a destructive one asks for. */
	answer: (id: string, optionId: string, confirmation?: string) => boolean;
}

/**
 * Wrap a transport so the store's own actions and the approval answer both
 * reach it checked against the assistant's narrower message set.
 */
function assistantSession(transport: ChatTransport): AssistantConversation {
	const deliver = (message: unknown) => {
		const parsed = AssistantClientMessage.safeParse(message);
		return parsed.success ? transport(parsed.data) : false;
	};
	return {
		store: createChatStore(deliver),
		answer: (id, optionId, confirmation) =>
			deliver({
				type: "permission.answer",
				id,
				optionId,
				...(confirmation === undefined ? {} : { confirmation }),
			}),
	};
}

/** One conversation's store, connected for as long as the view is mounted. */
export function useAssistantConversation(id: string): AssistantConversation {
	const [session] = useState(() => {
		const link: { send: ChatTransport } = { send: () => false };
		return { link, ...assistantSession((message) => link.send(message)) };
	});

	useEffect(() => {
		const { link, store } = session;
		const socket = connectChatStore(conversationSocketPath(id), store);
		link.send = socket.send;
		return () => {
			link.send = () => false;
			socket.stop();
		};
	}, [session, id]);

	return session;
}
