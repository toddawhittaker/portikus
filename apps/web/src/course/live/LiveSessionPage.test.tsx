import { CloseCode, type CourseLiveHelpDetail } from "@portikus/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER } from "../../test-utils.js";

const COURSE = "55555555-5555-4555-8555-555555555555";
const SESSION = "66666666-6666-4666-8666-666666666666";
const TERMINAL = "77777777-7777-4777-8777-777777777777";
const BASE = `/courses/${COURSE}/live-help/${SESSION}`;

const sockets: FakeSocket[] = [];

class FakeSocket {
	static readonly OPEN = 1;
	readonly url: string;
	readyState = 1;
	binaryType = "blob";
	closed = false;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	constructor(url: string) {
		this.url = url;
		sockets.push(this);
	}
	send() {}
	close() {
		this.closed = true;
	}
}

function detail(typing: boolean): CourseLiveHelpDetail {
	return {
		session: {
			id: SESSION,
			projectId: "88888888-8888-4888-8888-888888888888",
			projectName: "todo-api",
			userId: "99999999-9999-4999-8999-999999999999",
			displayName: "Ada Student",
			typing,
			startedAt: "2026-10-12T10:00:00.000Z",
			endsAt: "2026-10-12T11:00:00.000Z",
			workspaceState: "running",
		},
		studentConnected: true,
		terminals: [{ id: TERMINAL, name: "Terminal 1" }],
	};
}

let typing = false;
let left = false;

beforeEach(() => {
	typing = false;
	left = false;
	sockets.length = 0;
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			matches: false,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})),
	);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.stubGlobal("WebSocket", FakeSocket);
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, USER);
		if (url === BASE) return json(200, detail(typing));
		if (url === `${BASE}/listening`) return json(200, { services: [] });
		if (url === `${BASE}/leave` && init?.method === "POST") {
			left = true;
			return json(204, null);
		}
		if (url === `/courses/${COURSE}/live-help`) return json(200, { sessions: [] });
		return json(404, { code: "NOT_FOUND", message: "no" });
	});
});

afterEach(() => vi.unstubAllGlobals());

function terminalSockets(): FakeSocket[] {
	return sockets.filter((socket) => socket.url.includes(`/terminals/${TERMINAL}/ws`));
}

async function openPage() {
	renderApp(`/course/${COURSE}/live/${SESSION}`);
	await screen.findByTestId("helper-terminal", {}, { timeout: 5_000 });
	await waitFor(() => expect(terminalSockets()).toHaveLength(1));
	const textarea = document.querySelector<HTMLTextAreaElement>(
		"[data-testid=helper-terminal] textarea",
	);
	if (!textarea) throw new Error("no xterm textarea");
	return textarea;
}

function closeWith(socket: FakeSocket | undefined, code: number) {
	act(() => socket?.onclose?.({ code }));
}

test("a mode change attaches once, in the new mode, with the keyboard still in the terminal", async () => {
	const textarea = await openPage();
	textarea.focus();

	typing = true;
	closeWith(terminalSockets()[0], CloseCode.LIVE_HELP_MODE_CHANGED);

	await waitFor(() =>
		expect(screen.getByTestId("helper-terminal").dataset.mode).toBe("type"),
	);
	// Long enough for a second, doubled attach to show up if there were one.
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(terminalSockets()).toHaveLength(2);
	expect(document.activeElement).toBe(textarea);
});

test("a mode-change close with the mode unchanged still attaches again, once", async () => {
	await openPage();
	closeWith(terminalSockets()[0], CloseCode.LIVE_HELP_MODE_CHANGED);
	await waitFor(() => expect(terminalSockets()).toHaveLength(2));
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(terminalSockets()).toHaveLength(2);
});

test("Leave session lands the keyboard on the list page's heading", async () => {
	await openPage();
	fireEvent.click(screen.getByRole("button", { name: "Leave session" }));
	const heading = await screen.findByRole("heading", { level: 1, name: "Live help" });
	await waitFor(() => expect(document.activeElement).toBe(heading));
	expect(left).toBe(true);
	expect(heading.tabIndex).toBe(-1);
});

test("the list page does not take focus when reached any other way", async () => {
	renderApp(`/course/${COURSE}/live`);
	const heading = await screen.findByRole("heading", { level: 1, name: "Live help" });
	await screen.findByTestId("live-empty");
	expect(document.activeElement).not.toBe(heading);
});
