import { act, render } from "@testing-library/react";
import { expect, it } from "vitest";
import { ApiError } from "../api/request.js";
import { useMoveAskingToReplace } from "./ReplaceFileConfirm.js";

function clash(code: string) {
	return new ApiError(409, "that name is already taken", code);
}

function Harness({
	move,
	expose,
}: {
	move: (args: { from: string; to: string; replace?: boolean }) => Promise<unknown>;
	expose: (ask: ReturnType<typeof useMoveAskingToReplace>["moveAsking"]) => void;
}) {
	const { moveAsking, confirm } = useMoveAskingToReplace(move);
	expose(moveAsking);
	return confirm;
}

/** SPEC.md §11.2: a pending prompt never leaves a Move to loop waiting. */
it("answers keep when the pane unmounts with the prompt open", async () => {
	let ask: ReturnType<typeof useMoveAskingToReplace>["moveAsking"] | undefined;
	const view = render(
		<Harness
			move={() => Promise.reject(clash("FILE_EXISTS"))}
			expose={(fn) => {
				ask = fn;
			}}
		/>,
	);
	let result: Promise<boolean> | undefined;
	await act(async () => {
		result = ask?.("a.txt", "b.txt", false);
	});
	expect(document.querySelector('[data-testid="dialog-replace-file"]')).not.toBeNull();
	view.unmount();
	await expect(result).resolves.toBe(false);
});

it("does not prompt when the target is a folder", async () => {
	let ask: ReturnType<typeof useMoveAskingToReplace>["moveAsking"] | undefined;
	render(
		<Harness
			move={() => Promise.reject(clash("DIRECTORY_EXISTS"))}
			expose={(fn) => {
				ask = fn;
			}}
		/>,
	);
	await expect(ask?.("a.txt", "dir", false)).rejects.toMatchObject({
		code: "DIRECTORY_EXISTS",
	});
	expect(document.querySelector('[data-testid="dialog-replace-file"]')).toBeNull();
});
