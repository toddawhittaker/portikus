import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { speak, speakingId, stop } from "../voice/speak.js";
import { READ_ALOUD, SpeakButton, STOP_READING } from "./SpeakButton.js";
import {
	type FakeSynth,
	installFakeSpeech,
	removeFakeSpeech,
} from "./speechTesting.js";

let synth: FakeSynth;

beforeEach(() => {
	synth = installFakeSpeech();
});

afterEach(() => {
	cleanup();
	removeFakeSpeech();
	vi.useRealTimers();
});

test("it reads its reply, then becomes Stop, and Stop stops at once", () => {
	render(<SpeakButton id="r1" markdown={"Hello **there**. Done."} />);
	const button = screen.getByRole("button", { name: READ_ALOUD });
	fireEvent.click(button);
	expect(speakingId()).toBe("r1");
	expect(synth.said).toBe("Hello there. Done.");
	// The same button, renamed, so focus stays on it.
	const stopButton = screen.getByRole("button", { name: STOP_READING });
	expect(stopButton).toBe(button);
	fireEvent.click(stopButton);
	expect(speakingId()).toBeNull();
	expect(synth.cancelled).toBeGreaterThan(0);
	expect(screen.getByRole("button", { name: READ_ALOUD })).toBe(button);
});

test("only the reply being read shows Stop", () => {
	render(
		<>
			<SpeakButton id="a" markdown="First reply." />
			<SpeakButton id="b" markdown="Second reply." />
		</>,
	);
	act(() => speak("b", "Second reply."));
	expect(screen.getAllByRole("button", { name: READ_ALOUD })).toHaveLength(1);
	expect(screen.getAllByRole("button", { name: STOP_READING })).toHaveLength(1);
	// Reading another reply moves Stop to it.
	fireEvent.click(screen.getByRole("button", { name: READ_ALOUD }));
	expect(speakingId()).toBe("a");
	act(() => stop());
	expect(screen.getAllByRole("button", { name: READ_ALOUD })).toHaveLength(2);
});

test("the button is not drawn where the browser cannot speak", () => {
	vi.stubGlobal("speechSynthesis", undefined);
	const { container } = render(<SpeakButton id="r1" markdown="Hello." />);
	expect(container.textContent).toBe("");
	expect(screen.queryByRole("button")).toBeNull();
});
