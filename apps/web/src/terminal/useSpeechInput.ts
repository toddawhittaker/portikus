/**
 * Hold-to-talk dictation through the browser's own speech recognition
 * (SPEC.md §25.10). Audio goes from the browser to its vendor's service;
 * Portikus sends nothing to its server and logs nothing.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** The few members of the Web Speech API used here; no @types package. */
interface SpeechResultAlternative {
	transcript: string;
}
interface SpeechResult {
	readonly isFinal: boolean;
	readonly length: number;
	[index: number]: SpeechResultAlternative;
}
interface SpeechResultEvent {
	readonly resultIndex: number;
	readonly results: { readonly length: number; [index: number]: SpeechResult };
}
interface SpeechErrorEvent {
	readonly error: string;
}
export interface Recognizer {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((event: SpeechResultEvent) => void) | null;
	onerror: ((event: SpeechErrorEvent) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
}
type RecognizerClass = new () => Recognizer;

type SpeechState = "unsupported" | "idle" | "listening" | "error";

// Brave ships the API but its service always fails with `network`; once seen,
// every pane treats the browser as unsupported.
let networkFailed = false;

/** Forget a `network` failure; for tests. */
export function resetSpeechSupport(): void {
	networkFailed = false;
}

function recognizerClass(): RecognizerClass | null {
	const scope = globalThis as unknown as {
		SpeechRecognition?: RecognizerClass;
		webkitSpeechRecognition?: RecognizerClass;
	};
	return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/**
 * A transcript as typed input: every control character goes, line breaks
 * included, so dictation can never press Enter or send an escape sequence.
 */
export function sanitizeTranscript(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
	return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function errorMessage(code: string): string {
	if (code === "not-allowed" || code === "service-not-allowed") {
		return "Microphone access is blocked. Allow it in the browser's site settings.";
	}
	if (code === "audio-capture") return "No microphone was found.";
	if (code === "no-speech") return "No speech was heard.";
	return "Voice input stopped because of an error.";
}

export interface SpeechInput {
	state: SpeechState;
	/** Words heard so far that may still change; shown, never typed. */
	interim: string;
	/** What the status region says: "Listening…" or the last error. */
	message: string;
	start: () => void;
	stop: () => void;
}

/** `onFinal` receives each settled phrase, already sanitized. */
export function useSpeechInput(onFinal: (text: string) => void): SpeechInput {
	const [supported, setSupported] = useState(
		() => recognizerClass() !== null && !networkFailed,
	);
	const [state, setState] = useState<SpeechState>("idle");
	const [interim, setInterim] = useState("");
	const [message, setMessage] = useState("");
	const recognizer = useRef<Recognizer | null>(null);
	const finalRef = useRef(onFinal);
	finalRef.current = onFinal;

	const start = useCallback(() => {
		const Recognition = recognizerClass();
		if (!Recognition || networkFailed || recognizer.current) return;
		const rec = new Recognition();
		rec.continuous = true;
		rec.interimResults = true;
		rec.lang = navigator.language;
		rec.onresult = (event) => {
			let pending = "";
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const result = event.results[i];
				const text = result?.[0]?.transcript ?? "";
				if (result?.isFinal) {
					const clean = sanitizeTranscript(text);
					if (clean !== "") finalRef.current(clean);
				} else {
					pending += text;
				}
			}
			setInterim(pending);
		};
		rec.onerror = (event) => {
			if (event.error === "aborted") return;
			if (event.error === "network") {
				networkFailed = true;
				setSupported(false);
				return;
			}
			setState("error");
			setMessage(errorMessage(event.error));
		};
		rec.onend = () => {
			if (recognizer.current === rec) recognizer.current = null;
			setInterim("");
			setState((now) => (now === "listening" ? "idle" : now));
			setMessage((now) => (now === "Listening…" ? "" : now));
		};
		recognizer.current = rec;
		setState("listening");
		setMessage("Listening…");
		setInterim("");
		try {
			rec.start();
		} catch {
			recognizer.current = null;
			setState("error");
			setMessage(errorMessage(""));
		}
	}, []);

	// Stop, not abort: the last phrase still arrives as a final result.
	const stop = useCallback(() => {
		recognizer.current?.stop();
		setState((now) => (now === "listening" ? "idle" : now));
		setMessage((now) => (now === "Listening…" ? "" : now));
	}, []);

	useEffect(() => () => recognizer.current?.abort(), []);

	return { state: supported ? state : "unsupported", interim, message, start, stop };
}
