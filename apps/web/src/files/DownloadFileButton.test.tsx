import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../test-utils.js";
import { DownloadFileButton } from "./DownloadFileButton.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";

afterEach(() => vi.unstubAllGlobals());

function renderButton() {
	renderWithQuery(
		<DownloadFileButton
			workspaceId={WORKSPACE}
			projectId={PROJECT}
			path="data/big.bin"
			testId="file-download"
		/>,
	);
	const click = vi
		.spyOn(HTMLAnchorElement.prototype, "click")
		.mockImplementation(() => {});
	onTestFinished(() => click.mockRestore());
	return click;
}

test("Enter on the button checks the size, then downloads the file (#399)", async () => {
	const fetch = stubFetch(() => new Response(null, { status: 204 }));
	const click = renderButton();

	const button = screen.getByRole("button", { name: "Download big.bin" });
	button.focus();
	// A native button turns Enter into a click; jsdom does not, so click it.
	fireEvent.click(button);

	await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
	expect(fetch.mock.calls[0]?.[0]).toBe(
		`/workspaces/${WORKSPACE}/projects/${PROJECT}/download?path=data%2Fbig.bin&check=1`,
	);
	const link = click.mock.contexts[0] as HTMLAnchorElement;
	expect(link.getAttribute("href")).toBe(
		`/workspaces/${WORKSPACE}/projects/${PROJECT}/file?path=data%2Fbig.bin&download=1`,
	);
	expect(link.download).toBe("big.bin");
});

test("the button is busy during the size check and ignores repeats (Gate E)", async () => {
	let finish: (response: Response) => void = () => undefined;
	const fetch = stubFetch(
		() =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			}) as unknown as Response,
	);
	const click = renderButton();

	const button = screen.getByRole("button", { name: "Download big.bin" });
	button.focus();
	fireEvent.click(button);
	await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
	expect(button.getAttribute("aria-disabled")).toBe("true");
	expect(document.activeElement).toBe(button);
	fireEvent.click(button);
	expect(fetch).toHaveBeenCalledTimes(1);

	finish(new Response(null, { status: 204 }));
	await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
	await waitFor(() => expect(button.hasAttribute("aria-busy")).toBe(false));
});

test("a file over the cap shows the limit and does not download (#399)", async () => {
	stubFetch(() => json(413, { code: "FILE_TOO_LARGE", message: "too large" }));
	const click = renderButton();

	fireEvent.click(screen.getByRole("button", { name: "Download big.bin" }));

	expect(await screen.findByText("Downloads are limited to 1 GB")).toBeDefined();
	expect(
		screen.getByText(/Download a smaller folder, leave out node_modules/),
	).toBeDefined();
	expect(click).not.toHaveBeenCalled();
});
