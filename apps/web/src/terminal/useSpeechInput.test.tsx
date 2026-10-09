import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
	MESSAGE_MS,
	type Recognizer,
	resetSpeechSupport,
	sanitizeTranscript,
	useSpeechInput,
} from "./useSpeechInput";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	resetSpeechSupport();
});

/** A recognizer the test drives by hand. */
class FakeRecognition implements Recognizer {
	static last: FakeRecognition | null = null;
	continuous = false;
	interimResults = false;
	lang = "";
	onresult: Recognizer["onresult"] = null;
	onerror: Recognizer["onerror"] = null;
	onend: Recognizer["onend"] = null;
	started = false;
	stopped = false;
	constructor() {
		FakeRecognition.last = this;
	}
	start() {
		this.started = true;
	}
	stop() {
		this.stopped = true;
	}
	abort() {}
	say(text: string, isFinal: boolean) {
		const result = Object.assign([{ transcript: text }], { isFinal });
		this.onresult?.({ resultIndex: 0, results: [result] });
	}
}

function fake() {
	const recognizer = FakeRecognition.last;
	if (!recognizer) throw new Error("no recognizer was made");
	return recognizer;
}

test("a browser without the API is unsupported", () => {
	const { result } = renderHook(() => useSpeechInput(vi.fn()));
	expect(result.current.state).toBe("unsupported");
});

test("the webkit-prefixed API counts as support", () => {
	vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
	const { result } = renderHook(() => useSpeechInput(vi.fn()));
	expect(result.current.state).toBe("idle");
});

test("holding listens, shows interim words, and types only final ones", () => {
	vi.stubGlobal("SpeechRecognition", FakeRecognition);
	const onFinal = vi.fn();
	const { result } = renderHook(() => useSpeechInput(onFinal));

	act(() => result.current.start());
	expect(result.current.state).toBe("listening");
	expect(result.current.message).toBe("Listening…");
	expect(fake().started).toBe(true);
	expect(fake().interimResults).toBe(true);

	act(() => fake().say("git sta", false));
	expect(result.current.interim).toBe("git sta");
	expect(onFinal).not.toHaveBeenCalled();

	act(() => fake().say("git status", true));
	expect(onFinal).toHaveBeenCalledWith("git status");
	expect(result.current.interim).toBe("");

	act(() => result.current.stop());
	expect(fake().stopped).toBe(true);
	expect(result.current.state).toBe("idle");
	expect(result.current.message).toBe("");
});

test("a final phrase loses every control character, so it never presses Enter", () => {
	vi.stubGlobal("SpeechRecognition", FakeRecognition);
	const onFinal = vi.fn();
	const { result } = renderHook(() => useSpeechInput(onFinal));
	act(() => result.current.start());
	act(() => fake().say("ls\r\n-la\u001b[201~\n", true));
	expect(onFinal).toHaveBeenCalledWith("ls-la[201~");
});

test("sanitizeTranscript strips C0, DEL and C1 characters", () => {
	expect(sanitizeTranscript("a\u0000b\tc\rd\ne\u007ff\u0085g")).toBe("abcdefg");
});

test("a network error makes the browser unsupported", () => {
	vi.stubGlobal("SpeechRecognition", FakeRecognition);
	const { result } = renderHook(() => useSpeechInput(vi.fn()));
	act(() => result.current.start());
	act(() => fake().onerror?.({ error: "network" }));
	expect(result.current.state).toBe("unsupported");
	// Other panes made afterwards agree.
	const other = renderHook(() => useSpeechInput(vi.fn()));
	expect(other.result.current.state).toBe("unsupported");
});

test("a blocked microphone is an error with a message", () => {
	vi.stubGlobal("SpeechRecognition", FakeRecognition);
	const { result } = renderHook(() => useSpeechInput(vi.fn()));
	act(() => result.current.start());
	act(() => fake().onerror?.({ error: "not-allowed" }));
	act(() => fake().onend?.());
	expect(result.current.state).toBe("error");
	expect(result.current.message).toMatch(/Microphone access is blocked/);
	// Trying again listens again.
	act(() => result.current.start());
	expect(result.current.state).toBe("listening");
});

test("a network error says why and keeps saying it", () => {
	vi.stubGlobal("SpeechRecognition", FakeRecognition);
	const { result } = renderHook(() => useSpeechInput(vi.fn()));
	act(() => result.current.start());
	act(() => fake().onerror?.({ error: "network" }));
	expect(result.current.state).toBe("unsupported");
	expect(result.current.message).toBe("Voice input is not available in this browser.");
});

test("an error clears itself after a while", () => {
	vi.useFakeTimers();
	try {
		vi.stubGlobal("SpeechRecognition", FakeRecognition);
		const { result } = renderHook(() => useSpeechInput(vi.fn()));
		act(() => result.current.start());
		act(() => fake().onerror?.({ error: "audio-capture" }));
		expect(result.current.message).toBe("No microphone was found.");
		act(() => vi.advanceTimersByTime(MESSAGE_MS));
		expect(result.current.message).toBe("");
	} finally {
		vi.useRealTimers();
	}
});

test("a quick second press starts a new recognizer while the first finishes", () => {
	vi.stubGlobal("SpeechRecognition", FakeRecognition);
	const { result } = renderHook(() => useSpeechInput(vi.fn()));
	act(() => result.current.start());
	const first = fake();
	act(() => result.current.stop());
	expect(first.stopped).toBe(true);
	act(() => result.current.start());
	expect(fake()).not.toBe(first);
	expect(fake().started).toBe(true);
	expect(result.current.state).toBe("listening");
	// The first one ending late does not end the second.
	act(() => first.onend?.());
	expect(result.current.state).toBe("listening");
});

test("explain puts a hint in the message", () => {
	vi.stubGlobal("SpeechRecognition", FakeRecognition);
	const { result } = renderHook(() => useSpeechInput(vi.fn()));
	act(() => result.current.explain("Hold Space to talk."));
	expect(result.current.message).toBe("Hold Space to talk.");
});
