import {
	CHAT_START_SETTINGS,
	ChatLastSettings,
	type ChatModeInfo,
	type ChatModelInfo,
} from "@portikus/contracts";
import { useEffect, useState } from "react";
import { z } from "zod";
import { request, sendJson } from "../api/request.js";
import { chatSocketPath, openChatSocket } from "./chatSocket.js";
import {
	type ChatSettings,
	type ChatStore,
	type ChatTransport,
	createChatStore,
	isNewChat,
} from "./chatStore.js";
import { modeOf, offeredModel, offersEffort, sameModel } from "./models.js";

export function chatSettingsUrl(workspaceId: string, projectId: string): string {
	return `/workspaces/${workspaceId}/projects/${projectId}/chat-settings`;
}

/**
 * The values worth keeping from what the host confirmed. Claude's sit in
 * the flat keys with no agent. Codex's go in `codex`, beside the flat keys
 * the server ignores in that save, sent as they were stored (or the start
 * values when nothing was).
 */
export function lastSettingsOf(
	settings: ChatSettings,
	stored: ChatLastSettings | null = null,
): ChatLastSettings {
	const mine = { model: settings.model, effort: settings.effort, mode: settings.mode };
	if (settings.agent === "claude") return mine;
	const claude = stored ?? CHAT_START_SETTINGS;
	return {
		model: claude.model,
		effort: claude.effort,
		mode: claude.mode,
		agent: settings.agent,
		codex: mine,
	};
}

type AgentChange = Partial<Pick<ChatLastSettings, "model" | "effort" | "mode">>;

/**
 * The change that brings a new chat to the values last used with its own
 * agent; null when there is none or that agent has none stored. A saved
 * model the list no longer offers is replaced by its family's newest version,
 * or the default. An effort the model does not offer, and a mode that warns,
 * are left at the host's start (SPEC.md §10.8).
 */
export function changeToward(
	settings: ChatSettings,
	last: ChatLastSettings,
	models: readonly ChatModelInfo[],
	modes: readonly ChatModeInfo[] = [],
): AgentChange | null {
	const wanted = settings.agent === "codex" ? last.codex : last;
	if (!wanted) return null;
	const change: AgentChange = {};
	const model = offeredModel(models, wanted.model, settings.model);
	if (!sameModel(models, settings.model, model)) change.model = model;
	if (settings.effort !== wanted.effort && offersEffort(models, model, wanted.effort)) {
		change.effort = wanted.effort;
	}
	if (settings.mode !== wanted.mode && modeOf(modes, wanted.mode)?.warning !== true) {
		change.mode = wanted.mode;
	}
	return Object.keys(change).length > 0 ? change : null;
}

/**
 * The store for one chat tab, connected for as long as the view is mounted.
 * Closing the socket never stops the session; deleting the tab does. Every
 * socket gets its own snapshot and replay, so a remount simply attaches again.
 *
 * A new chat is brought to the settings last used in its project with its
 * own agent, and a picker change the host confirms is kept as that agent's
 * last used (SPEC.md §10.8). Claude's and Codex's are kept apart.
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
		// What the server holds, so a Codex save sends Claude's values back as they were.
		let stored: ChatLastSettings | null = null;
		let stopped = false;

		// Checked once, at the first settings after the stored values arrive.
		function applyLast() {
			const state = store.getState();
			if (!last || !state.settings || !state.loaded) return;
			const wanted = last;
			last = null;
			if (!isNewChat(state)) return;
			const change = changeToward(state.settings, wanted, state.models, state.modes);
			if (!change) return;
			state.set(change);
			// The stored values are not a new choice, so their echo is not saved again.
			asked.change = false;
		}

		request(ChatLastSettings.optional(), url)
			.then((saved) => {
				if (stopped) return;
				last = saved ?? null;
				stored = saved ?? null;
				applyLast();
			})
			// Without the stored values a chat simply starts at the host's.
			.catch(() => {});

		const unsubscribe = store.subscribe((state, previous) => {
			if (state.settings === previous.settings || !state.settings) return;
			if (last) applyLast();
			if (!asked.change) return;
			asked.change = false;
			const saving = lastSettingsOf(state.settings, stored);
			void sendJson(z.unknown(), url, saving, "PUT").catch(
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
