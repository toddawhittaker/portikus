/**
 * A fake `speechSynthesis` for tests: utterances are recorded and finish
 * only when the test says so. Call `installFakeSpeech()` in `beforeEach`
 * and `removeFakeSpeech()` in `afterEach`.
 */
import { vi } from "vitest";
import { resetSpeech } from "../voice/speak.js";

class FakeUtterance {
	lang = "";
	voice: SpeechSynthesisVoice | null = null;
	onend: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(public text: string) {}
}

export class FakeSynth extends EventTarget {
	spoken: FakeUtterance[] = [];
	cancelled = 0;
	getVoices(): SpeechSynthesisVoice[] {
		return [];
	}
	speak(utterance: FakeUtterance): void {
		this.spoken.push(utterance);
	}
	cancel(): void {
		this.cancelled += 1;
	}
	/** The words spoken so far, in order. */
	get said(): string {
		return this.spoken.map((utterance) => utterance.text).join(" ");
	}
}

export function installFakeSpeech(): FakeSynth {
	const synth = new FakeSynth();
	vi.stubGlobal("speechSynthesis", synth);
	vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
	return synth;
}

export function removeFakeSpeech(): void {
	resetSpeech();
	vi.unstubAllGlobals();
}
