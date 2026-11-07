import { useEffect, useState } from "react";
import { chatSocketPath, openChatSocket } from "./chatSocket.js";
import { type ChatStore, type ChatTransport, createChatStore } from "./chatStore.js";

/**
 * The store for one chat tab, connected for as long as the view is mounted.
 * Closing the socket never stops the session; deleting the tab does. Every
 * socket gets its own snapshot and replay, so a remount simply attaches again.
 */
export function useChatSession(workspaceId: string, terminalId: string): ChatStore {
	const [session] = useState(() => {
		const link: { send: ChatTransport } = { send: () => false };
		return { link, store: createChatStore((message) => link.send(message)) };
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

	return session.store;
}
