import type { ChatServerEvent } from "@portikus/contracts";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { request, sendJson } from "../api/request.js";
import { speak, speakingId } from "../voice/speak.js";
import { createChatStore } from "./chatStore.js";
import {
	overlayOpen,
	replyToRead,
	useReadAloud,
	useReadNewReplies,
	useStopWhenLeaving,
} from "./readAloud.js";
import {
	type FakeSynth,
	installFakeSpeech,
	removeFakeSpeech,
} from "./speechTesting.js";

vi.mock("../api/request.js", () => ({
	request: vi.fn(),
	sendJson: vi.fn(),
}));

const SESSION = "11111111-1111-4111-8111-111111111111";

type Body<T extends ChatServerEvent["type"]> = Omit<
	Extract<ChatServerEvent, { type: T }>,
	"sessionId" | "seq" | "type"
>;

let seq = 0;
let synth: FakeSynth;

function frame<T extends ChatServerEvent["type"]>(type: T, body: Body<T>): string {
	return JSON.stringify({ type, sessionId: SESSION, seq: seq++, ...body });
}

function chat() {
	const store = createChatStore(() => true);
	store
		.getState()
		.receive(frame("snapshot", { cards: [], turnRunning: false, truncated: false }));
	return {
		store,
		start: () => store.getState().receive(frame("turn.started", { at: 1 })),
		say: (id: string, markdown: string) =>
			store.getState().receive(frame("message", { id, role: "assistant", markdown })),
		tool: (id: string, output: string) => {
			const { receive } = store.getState();
			receive(frame("tool.started", { id, name: "Bash", title: "ls", input: {} }));
			receive(frame("tool.output", { id, part: { type: "text", text: output } }));
			receive(frame("tool.finished", { id, isError: false }));
		},
		finish: (status: "done" | "interrupted" | "error" = "done") =>
			store.getState().receive(frame("turn.finished", { at: 2, status })),
	};
}

beforeEach(() => {
	seq = 0;
	synth = installFakeSpeech();
	vi.mocked(request).mockReset();
	vi.mocked(sendJson).mockReset();
	vi.mocked(sendJson).mockResolvedValue(undefined);
});

afterEach(() => {
	cleanup();
	removeFakeSpeech();
});

test("the reply read is the finished turn's last written message, never a tool or narration", () => {
	const { store, start, say, tool, finish } = chat();
	start();
	say("m1", "Let me look.");
	tool("t1", "SECRET TOOL OUTPUT");
	say("m2", "The answer is 42.");
	const before = store.getState();
	finish();
	const after = store.getState();
	expect(replyToRead(before, after)?.id).toBe("m2");
});

test("no reply is read for a turn that was stopped, failed, or wrote nothing", () => {
	for (const status of ["interrupted", "error"] as const) {
		const { store, start, say, finish } = chat();
		start();
		say("m1", "Half an answer");
		const before = store.getState();
		finish(status);
		expect(replyToRead(before, store.getState())).toBeNull();
	}
	const { store, start, tool, finish } = chat();
	start();
	tool("t1", "output");
	const before = store.getState();
	finish();
	expect(replyToRead(before, store.getState())).toBeNull();
});

test("nothing is read while the turn is still running or when none was running", () => {
	const { store, start, say } = chat();
	start();
	say("m1", "Hello.");
	expect(replyToRead(store.getState(), store.getState())).toBeNull();
	const done = chat();
	done.say("m1", "Old reply");
	expect(replyToRead(done.store.getState(), done.store.getState())).toBeNull();
});

test("with the switch on, a finished turn's reply is spoken and tool output is not", () => {
	const { store, start, say, tool, finish } = chat();
	renderHook(() => useReadNewReplies(store, true, true));
	start();
	say("m1", "Checking.");
	tool("t1", "SECRET TOOL OUTPUT");
	say("m2", "All **done**.");
	expect(synth.spoken).toHaveLength(0);
	finish();
	expect(speakingId()).toBe("m2");
	expect(synth.said).toBe("All done.");
});

test("with the switch off nothing is spoken", () => {
	const { store, start, say, finish } = chat();
	renderHook(() => useReadNewReplies(store, false, true));
	start();
	say("m1", "Done.");
	finish();
	expect(synth.spoken).toHaveLength(0);
});

test("a chat that is not showing does not start speaking", () => {
	const { store, start, say, finish } = chat();
	renderHook(() => useReadNewReplies(store, true, false));
	start();
	say("m1", "Done.");
	finish();
	expect(synth.spoken).toHaveLength(0);
});

test("a new reply replaces the one being read", () => {
	const { store, start, say, finish } = chat();
	renderHook(() => useReadNewReplies(store, true, true));
	start();
	say("m1", "First.");
	finish();
	expect(speakingId()).toBe("m1");
	start();
	say("m2", "Second.");
	finish();
	expect(speakingId()).toBe("m2");
	expect(synth.cancelled).toBeGreaterThan(0);
});

test("where speech is missing, nothing is spoken", () => {
	vi.stubGlobal("speechSynthesis", undefined);
	const { store, start, say, finish } = chat();
	renderHook(() => useReadNewReplies(store, true, true));
	start();
	say("m1", "Done.");
	finish();
	expect(speakingId()).toBeNull();
});

test("hiding the chat stops its speech, but not another chat's", () => {
	const mine = chat();
	mine.say("m1", "Mine.");
	const { rerender } = renderHook(
		({ visible }) => useStopWhenLeaving(mine.store, visible),
		{
			initialProps: { visible: true },
		},
	);
	act(() => speak("someone-else", "Not mine."));
	rerender({ visible: false });
	expect(speakingId()).toBe("someone-else");
	act(() => speak("m1", "Mine."));
	rerender({ visible: true });
	expect(speakingId()).toBe("m1");
	rerender({ visible: false });
	expect(speakingId()).toBeNull();
});

test("closing the chat, or leaving the page, stops its speech", () => {
	const mine = chat();
	mine.say("m1", "Mine.");
	const view = renderHook(() => useStopWhenLeaving(mine.store, true));
	act(() => speak("m1", "Mine."));
	view.unmount();
	expect(speakingId()).toBeNull();

	renderHook(() => useStopWhenLeaving(mine.store, true));
	act(() => speak("elsewhere", "Anything."));
	window.dispatchEvent(new Event("pagehide"));
	expect(speakingId()).toBeNull();
});

test("the switch starts from the saved value, and a choice is saved alone", async () => {
	vi.mocked(request).mockResolvedValue({
		model: "opus",
		effort: "low",
		mode: "plan",
		readAloud: true,
	});
	const { result } = renderHook(() => useReadAloud("w1", "p1"));
	expect(result.current.on).toBe(false);
	await waitFor(() => expect(result.current.on).toBe(true));
	expect(vi.mocked(request).mock.calls[0]?.[1]).toBe(
		"/workspaces/w1/projects/p1/chat-settings",
	);

	act(() => result.current.set(false));
	expect(result.current.on).toBe(false);
	expect(sendJson).toHaveBeenCalledWith(
		expect.anything(),
		"/workspaces/w1/projects/p1/chat-settings",
		{ readAloud: false },
		"PUT",
	);
});

test("a choice made while the saved value loads is not overwritten by it", async () => {
	let arrive: (value: unknown) => void = () => {};
	vi.mocked(request).mockReturnValue(new Promise((resolve) => (arrive = resolve)));
	const { result } = renderHook(() => useReadAloud("w1", "p1"));
	act(() => result.current.set(true));
	await act(async () => arrive({ readAloud: false }));
	expect(result.current.on).toBe(true);
});

test("a project with nothing saved, or a failed load or save, leaves the switch off", async () => {
	vi.mocked(request).mockResolvedValue(undefined);
	const first = renderHook(() => useReadAloud("w1", "p1"));
	await act(async () => {});
	expect(first.result.current.on).toBe(false);
	vi.mocked(request).mockRejectedValue(new Error("offline"));
	vi.mocked(sendJson).mockRejectedValue(new Error("offline"));
	const second = renderHook(() => useReadAloud("w1", "p2"));
	await act(async () => {});
	expect(second.result.current.on).toBe(false);
	act(() => second.result.current.set(true));
	await act(async () => {});
	expect(second.result.current.on).toBe(true);
});

test("a menu or dialog being open is told apart from a plain page", () => {
	expect(overlayOpen()).toBe(false);
	document.body.insertAdjacentHTML("beforeend", '<div role="menu" id="m"></div>');
	expect(overlayOpen()).toBe(true);
	document.getElementById("m")?.remove();
	document.body.insertAdjacentHTML(
		"beforeend",
		'<button id="t" aria-haspopup="menu" aria-expanded="true"></button>',
	);
	expect(overlayOpen()).toBe(true);
	document.getElementById("t")?.remove();
	// A disclosure that is open is not an overlay.
	document.body.insertAdjacentHTML(
		"beforeend",
		'<button id="d" aria-expanded="true"></button>',
	);
	expect(overlayOpen()).toBe(false);
	document.getElementById("d")?.remove();
});
