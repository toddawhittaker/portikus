import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { SpeechInput } from "./useSpeechInput";
import { VoiceButton } from "./VoiceButton";

afterEach(cleanup);

function voice(): SpeechInput {
	return {
		state: "idle",
		interim: "",
		message: "",
		start: vi.fn(),
		stop: vi.fn(),
		explain: vi.fn(),
	};
}

// The terminal's use of this button is pinned in PaneFrame.test.tsx; this
// checks that what the caller passes in is what the button uses.
test("the button carries the caller's name, test ids and hint", () => {
	const speech = voice();
	render(
		<VoiceButton
			testId="file-voice"
			statusTestId="file-voice-status"
			label="Hold to talk into a.txt"
			hint="Hold Space to talk."
			voice={speech}
			focusTarget={() => {}}
		/>,
	);
	const button = screen.getByTestId("file-voice");
	expect(screen.getByRole("button", { name: /Hold to talk into a\.txt/ })).toBe(button);
	fireEvent.click(button, { detail: 0 });
	expect(speech.explain).toHaveBeenCalledWith("Hold Space to talk.");
	expect(screen.getByTestId("file-voice-status").getAttribute("role")).toBe("status");
});
