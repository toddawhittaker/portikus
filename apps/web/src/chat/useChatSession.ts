import { ChatLastSettings } from "@portikus/contracts";
import { useEffect, useState } from "react";
import { z } from "zod";
import { request, sendJson } from "../api/request.js";
import { chatSocketPath, openChatSocket } from "./chatSocket.js";
import {
	type ChatStore,
	type ChatTransport,
	changeToward,
	createChatStore,
	isNewChat,
	lastSettingsOf,
} from "./chatStore.js";

function chatSettingsUrl(workspaceId: string, projectId: string): string {
	return `/workspaces/${workspaceId}/projects/${projectId}/chat-settings`;
}

/**
 * The store for one chat tab, connected for as long as the view is mounted.
 * Closing the socket never stops the session; deleting the tab does. Every
 * socket gets its own snapshot and replay, so a remount simply attaches again.
 *
 * A new chat is brought to the settings last used in its project, and a
 * picker change the host confirms is kept as the project's last used
 * (SPEC.md §10.8).
 */
export function useChatSession(
	workspaceId: string,
	projectId: string,
	terminalId: string,
): ChatStore {
	const [session] = useState(() => {
		const link: { send: ChatTransport } = { send: () => false };
		// A student's change, sent and not yet confirmed by a `settings` event.
		const asked = { change: false };
		const store = createChatStore((message) => {
			const sent = link.send(message);
			if (sent && message.type === "set") asked.change = true;
			return sent;
		});
		return { link, store, asked };
	});

	useEffect(() => {
		const { link, store } = session;
		const actions = store.getState();
		actions.setConnection("connecting");
		const socket = openChatSocket(chatSocketPath(workspaceId, terminalId), {
			onOpen: () => actions.setConnection("open"),
			onFrame: (data) => actions.receive(data),
			onReconnecting: () => actions.setConnection("reconnecting"),
			onLost: () => actions.setConnection("lost"),
			onTooMany: () => actions.setConnection("tooMany"),
			onNotFound: () => actions.setConnection("notFound"),
		});
		link.send = socket.send;
		return () => {
			link.send = () => false;
			socket.stop();
		};
	}, [session, workspaceId, terminalId]);

	useEffect(() => {
		const { store, asked } = session;
		const url = chatSettingsUrl(workspaceId, projectId);
		let last: ChatLastSettings | null | undefined;
		let stopped = false;

		// Checked once, at the first settings after the stored values arrive.
		function applyLast() {
			const state = store.getState();
			if (!last || !state.settings || !state.loaded) return;
			const wanted = last;
			last = null;
			if (!isNewChat(state)) return;
			const change = changeToward(state.settings, wanted);
			if (!change) return;
			state.set(change);
			// The stored values are not a new choice, so their echo is not saved again.
			asked.change = false;
		}

		request(ChatLastSettings.optional(), url)
			.then((stored) => {
				if (stopped) return;
				last = stored ?? null;
				applyLast();
			})
			// Without the stored values a chat simply starts at the host's.
			.catch(() => {});

		const unsubscribe = store.subscribe((state, previous) => {
			if (state.settings === previous.settings || !state.settings) return;
			if (last) applyLast();
			if (!asked.change) return;
			asked.change = false;
			void sendJson(z.unknown(), url, lastSettingsOf(state.settings), "PUT").catch(
				// A save that fails leaves the earlier values; the next change tries again.
				() => {},
			);
		});
		return () => {
			stopped = true;
			unsubscribe();
		};
	}, [session, workspaceId, projectId]);

	return session.store;
}
