import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	chooseVoice,
	isSpeechSupported,
	resetSpeech,
	speak,
	speakingId,
	stop,
	subscribeSpeech,
	useSpeechState,
} from "./speak";

class FakeUtterance {
	lang = "";
	voice: SpeechSynthesisVoice | null = null;
	onend: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(public text: string) {}
}

/** A speechSynthesis the test drives: utterances finish only when told. */
class FakeSynth extends EventTarget {
	voices: SpeechSynthesisVoice[] = [];
	spoken: FakeUtterance[] = [];
	cancelled = 0;
	getVoices() {
		return this.voices;
	}
	speak(utterance: FakeUtterance) {
		this.spoken.push(utterance);
	}
	cancel() {
		this.cancelled += 1;
		// Chrome reports the cut-off utterance as ended.
		this.spoken.at(-1)?.onend?.();
	}
	finishLast() {
		this.spoken.at(-1)?.onend?.();
	}
}

function voice(name: string, lang: string, localService: boolean): SpeechSynthesisVoice {
	return { name, lang, localService, default: false, voiceURI: name } as SpeechSynthesisVoice;
}

let synth: FakeSynth;

beforeEach(() => {
	synth = new FakeSynth();
	vi.stubGlobal("speechSynthesis", synth);
	vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
	document.documentElement.lang = "en-US";
});

afterEach(() => {
	resetSpeech();
	cleanup();
	vi.unstubAllGlobals();
	document.documentElement.lang = "";
});

const LONG = Array.from({ length: 20 }, (_, i) => `Sentence ${i} has a few words in it.`).join(" ");

test("support needs both speechSynthesis and the utterance class", () => {
	expect(isSpeechSupported()).toBe(true);
	vi.stubGlobal("SpeechSynthesisUtterance", undefined);
	expect(isSpeechSupported()).toBe(false);
	vi.stubGlobal("speechSynthesis", undefined);
	expect(isSpeechSupported()).toBe(false);
	speak("a", "Hello.");
	expect(speakingId()).toBeNull();
});

test("a reply speaks chunk by chunk and the state clears at the end", () => {
	speak("r1", `# Title\n\n${LONG}\n\n\`\`\`\nhidden()\n\`\`\``);
	expect(speakingId()).toBe("r1");
	expect(synth.spoken).toHaveLength(1);
	expect(synth.spoken[0]?.text).toBe("Title.");
	expect(synth.spoken[0]?.lang).toBe("en-us");
	let guard = 0;
	while (speakingId() && guard++ < 50) synth.finishLast();
	const texts = synth.spoken.map((u) => u.text);
	expect(texts.length).toBeGreaterThan(3);
	expect(texts.at(-1)).toBe("Code block.");
	expect(texts.join(" ")).not.toContain("hidden");
	expect(speakingId()).toBeNull();
});

test("starting another reply stops the current one at once", () => {
	speak("r1", LONG);
	const before = synth.spoken.length;
	speak("r2", "Second reply.");
	expect(synth.cancelled).toBeGreaterThan(0);
	expect(speakingId()).toBe("r2");
	// The cancelled run's end event must not queue more of the first reply.
	expect(synth.spoken.slice(before).map((u) => u.text)).toEqual(["Second reply."]);
});

test("stop cancels speech and clears the state", () => {
	speak("r1", LONG);
	const count = synth.spoken.length;
	stop();
	expect(speakingId()).toBeNull();
	expect(synth.spoken).toHaveLength(count);
});

test("an error ends the reply; a stale error is ignored", () => {
	speak("r1", LONG);
	const first = synth.spoken[0];
	first?.onerror?.();
	expect(speakingId()).toBeNull();
	speak("r2", LONG);
	first?.onerror?.();
	expect(speakingId()).toBe("r2");
});

test("a reply with nothing to say does not speak", () => {
	speak("r1", "---");
	expect(synth.spoken).toHaveLength(0);
	expect(speakingId()).toBeNull();
});

test("voice choice prefers a local voice in the page's language", () => {
	const online = voice("Google US", "en-US", false);
	const localGb = voice("Daniel", "en-GB", true);
	const localUs = voice("Samantha", "en-US", true);
	expect(chooseVoice([online, localGb, localUs], "en-US")).toBe(localUs);
	expect(chooseVoice([online, localGb], "en-us")).toBe(localGb);
	expect(chooseVoice([online], "en-US")).toBeNull();
	expect(chooseVoice([voice("Thomas", "fr-FR", true)], "en-US")).toBeNull();
});

test("the voice list arriving late is picked up", () => {
	speak("r1", "One.");
	expect(synth.spoken[0]?.voice).toBeNull();
	const local = voice("Samantha", "en-US", true);
	synth.voices = [voice("Google US", "en-US", false), local];
	synth.dispatchEvent(new Event("voiceschanged"));
	speak("r2", "Two.");
	expect(synth.spoken.at(-1)?.voice).toBe(local);
	synth.voices = [];
	synth.dispatchEvent(new Event("voiceschanged"));
	speak("r3", "Three.");
	expect(synth.spoken.at(-1)?.voice).toBeNull();
});

test("the page language falls back to the browser's", () => {
	document.documentElement.lang = "";
	speak("r1", "One.");
	expect(synth.spoken[0]?.lang).toBe(navigator.language.toLowerCase());
});

test("subscribers and the hook follow the reply being read", () => {
	const seen: (string | null)[] = [];
	const off = subscribeSpeech(() => seen.push(speakingId()));
	const { result } = renderHook(() => useSpeechState());
	expect(result.current).toBeNull();
	act(() => speak("r1", "Hello."));
	expect(result.current).toBe("r1");
	act(() => synth.finishLast());
	expect(result.current).toBeNull();
	off();
	speak("r2", "Again.");
	expect(seen).toEqual(["r1", null]);
});
