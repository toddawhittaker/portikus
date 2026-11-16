import { type ChatSocket, openChatSocket } from "./chatSocket.js";
import type { ChatStore } from "./chatStore.js";

/** Open a socket that feeds `store` and keeps its connection state. */
export function connectChatStore(path: string, store: ChatStore): ChatSocket {
	const actions = store.getState();
	actions.setConnection("connecting");
	return openChatSocket(path, {
		onOpen: () => actions.setConnection("open"),
		onFrame: (data) => actions.receive(data),
		onReconnecting: () => actions.setConnection("reconnecting"),
		onLost: () => actions.setConnection("lost"),
		onTooMany: () => actions.setConnection("tooMany"),
		onNotFound: () => actions.setConnection("notFound"),
	});
}
