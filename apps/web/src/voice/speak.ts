/**
 * Reads chat replies aloud through the browser's `speechSynthesis`
 * (ADR 0071). One reply speaks at a time across the page. The text goes
 * only to the browser; Portikus sends, stores and logs none of it (ADR 0012).
 */
import { useSyncExternalStore } from "react";
import { toSpeechChunks } from "./speechText.js";

/** True when the browser can speak; controls are hidden otherwise. */
export function isSpeechSupported(): boolean {
	return (
		typeof globalThis.speechSynthesis === "object" &&
		globalThis.speechSynthesis !== null &&
		typeof globalThis.SpeechSynthesisUtterance === "function"
	);
}

function pageLanguage(): string {
	return (document.documentElement.lang || navigator.language || "en").toLowerCase();
}

/**
 * Prefers a voice on this device in the page's language, since online
 * voices send the text to the browser vendor. Null leaves the browser's
 * default voice.
 */
export function chooseVoice(
	voices: readonly SpeechSynthesisVoice[],
	language: string,
): SpeechSynthesisVoice | null {
	const lang = language.toLowerCase();
	const primary = lang.split("-")[0];
	const local = voices.filter((voice) => voice.localService);
	return (
		local.find((voice) => voice.lang.toLowerCase() === lang) ??
		local.find((voice) => voice.lang.toLowerCase().split("-")[0] === primary) ??
		null
	);
}

let speaking: string | null = null;
let generation = 0;
const listeners = new Set<() => void>();
let voice: SpeechSynthesisVoice | null | undefined;
let watchingVoices = false;

function setSpeaking(id: string | null): void {
	if (speaking === id) return;
	speaking = id;
	for (const listener of listeners) listener();
}

// Chrome fills the voice list after load, so the choice is redone when it changes.
function currentVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
	if (!watchingVoices) {
		watchingVoices = true;
		synth.addEventListener("voiceschanged", () => {
			voice = undefined;
		});
	}
	if (voice === undefined) {
		const voices = synth.getVoices();
		const chosen = chooseVoice(voices, pageLanguage());
		if (voices.length === 0) return null;
		voice = chosen;
	}
	return voice;
}

/** Stops whatever is being read, at once. */
export function stop(): void {
	generation += 1;
	if (isSpeechSupported()) globalThis.speechSynthesis.cancel();
	setSpeaking(null);
}

/** Reads one reply aloud, stopping any other first. */
export function speak(id: string, markdown: string): void {
	stop();
	if (!isSpeechSupported()) return;
	const chunks = toSpeechChunks(markdown);
	if (chunks.length === 0) return;
	const synth = globalThis.speechSynthesis;
	const mine = generation;
	const lang = pageLanguage();
	// One utterance at a time: Chrome cuts long ones off, and a cancelled
	// run's late end events must not start the next chunk.
	const next = (index: number): void => {
		if (mine !== generation) return;
		if (index >= chunks.length) {
			setSpeaking(null);
			return;
		}
		const utterance = new SpeechSynthesisUtterance(chunks[index]);
		utterance.lang = lang;
		const chosen = currentVoice(synth);
		if (chosen) utterance.voice = chosen;
		utterance.onend = () => next(index + 1);
		utterance.onerror = () => {
			if (mine === generation) setSpeaking(null);
		};
		synth.speak(utterance);
	};
	setSpeaking(id);
	next(0);
}

/** The id of the reply being read, or null. */
export function speakingId(): string | null {
	return speaking;
}

/** Calls the listener whenever the reply being read changes. */
export function subscribeSpeech(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The id of the reply being read, or null, kept current in React. */
export function useSpeechState(): string | null {
	return useSyncExternalStore(subscribeSpeech, speakingId, speakingId);
}

/** Forgets the chosen voice and the voice watcher; for tests. */
export function resetSpeech(): void {
	stop();
	voice = undefined;
	watchingVoices = false;
}
