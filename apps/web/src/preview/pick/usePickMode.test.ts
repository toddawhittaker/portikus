/**
 * The trust rules of pick mode (SPEC.md §24): which messages count, when a
 * pick counts, and that the agent, port, time and file types come from the
 * Portikus page and never from the message.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	type AgentDropTarget,
	registerAgentDropTarget,
} from "../../agents/agentDropTargets.js";
import { PICK_PNG_MAX_BYTES } from "./messages.js";
import { PICK_MARKDOWN_FILE_NAME, PICK_PNG_FILE_NAME } from "./pickFile.js";
import { type UsePickModeOptions, usePickMode } from "./usePickMode.js";

const ORIGIN = "https://alice-5173.preview.portikus.example.edu";
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];

let iframe: HTMLIFrameElement;
let other: HTMLIFrameElement;

beforeEach(() => {
	iframe = document.createElement("iframe");
	other = document.createElement("iframe");
	document.body.append(iframe, other);
});

const offs: Array<() => void> = [];

afterEach(() => {
	cleanup();
	for (const off of offs.splice(0)) off();
	iframe.remove();
	other.remove();
	vi.useRealTimers();
});

/** An open agent pane, listed as a drop target. */
function target(id = "t1"): AgentDropTarget & { deliver: ReturnType<typeof vi.fn> } {
	const made = {
		terminalId: id,
		label: `Agent ${id}`,
		deliver: vi.fn(async () => true),
	};
	act(() => {
		offs.push(registerAgentDropTarget(made));
	});
	return made;
}

function picked(overrides: Record<string, unknown> = {}) {
	return {
		v: 1,
		type: "picked",
		pagePath: "/about",
		selector: "main > h1",
		tag: "h1",
		html: "<h1>Hi</h1>",
		rules: [],
		computed: { color: "red" },
		trimmed: { html: false, rules: false },
		...overrides,
	};
}

function send(data: unknown, from: { origin?: string; source?: Window | null } = {}) {
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data,
				origin: from.origin ?? ORIGIN,
				source: from.source === undefined ? iframe.contentWindow : from.source,
			}),
		);
	});
}

async function settle() {
	await act(async () => {});
}

function setup(overrides: Partial<UsePickModeOptions> = {}) {
	const options = {
		frame: { current: iframe },
		previewOrigin: ORIGIN,
		frameKey: "grant-1",
		port: 5173,
		onDelivered: vi.fn(),
		onError: vi.fn(),
		...overrides,
	};
	const hook = renderHook((props: UsePickModeOptions) => usePickMode(props), {
		initialProps: options,
	});
	return { ...hook, options };
}

function delivered(t: ReturnType<typeof target>): File[] {
	return t.deliver.mock.calls[0]?.[0] as File[];
}

test("start posts start to the frame with the preview origin as target", () => {
	const post = vi.spyOn(iframe.contentWindow as Window, "postMessage");
	const { result } = setup();
	act(() => result.current.start(target()));
	expect(result.current.state).toBe("picking");
	expect(post).toHaveBeenCalledWith({ v: 1, type: "start" }, ORIGIN);
});

test("a pick from another origin is refused", async () => {
	const t = target();
	const { result } = setup();
	act(() => result.current.start(t));
	send(picked(), { origin: "https://evil.example" });
	await settle();
	expect(t.deliver).not.toHaveBeenCalled();
	expect(result.current.state).toBe("picking");
});

test("a pick from the right origin but another window is refused", async () => {
	const t = target();
	const { result } = setup();
	act(() => result.current.start(t));
	send(picked(), { source: other.contentWindow });
	send(picked(), { source: null });
	await settle();
	expect(t.deliver).not.toHaveBeenCalled();
});

test("a message that does not fit the schema is refused", async () => {
	const t = target();
	const { result } = setup();
	act(() => result.current.start(t));
	send(picked({ v: 2 }));
	send(picked({ extra: true }));
	send("picked");
	await settle();
	expect(t.deliver).not.toHaveBeenCalled();
});

test("hover, picked and cancelled are ignored outside pick mode", async () => {
	const { result, options } = setup();
	send({ v: 1, type: "hover", label: "h1" });
	send({ v: 1, type: "cancelled" });
	send(picked());
	await settle();
	expect(result.current.state).toBe("idle");
	expect(result.current.hoverLabel).toBe("");
	expect(options.onDelivered).not.toHaveBeenCalled();
});

test("hover labels show while picking and cancelled leaves pick mode", () => {
	const { result } = setup();
	act(() => result.current.start(target()));
	send({ v: 1, type: "hover", label: "heading Welcome" });
	expect(result.current.hoverLabel).toBe("heading Welcome");
	send({ v: 1, type: "cancelled" });
	expect(result.current.state).toBe("idle");
	expect(result.current.hoverLabel).toBe("");
});

test("only the first pick per start is taken", async () => {
	const t = target();
	const { result, options } = setup();
	act(() => result.current.start(t));
	send(picked());
	send(picked({ tag: "p" }));
	await settle();
	expect(t.deliver).toHaveBeenCalledTimes(1);
	expect(options.onDelivered).toHaveBeenCalledWith(t);
	expect(result.current.state).toBe("idle");
	send(picked());
	await settle();
	expect(t.deliver).toHaveBeenCalledTimes(1);
});

test("Escape in the Portikus page stops picking, and a later pick is refused", async () => {
	const post = vi.spyOn(iframe.contentWindow as Window, "postMessage");
	const t = target();
	const { result } = setup();
	act(() => result.current.start(t));
	act(() => {
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
	});
	expect(result.current.state).toBe("idle");
	expect(post).toHaveBeenLastCalledWith({ v: 1, type: "stop" }, ORIGIN);
	send(picked());
	await settle();
	expect(t.deliver).not.toHaveBeenCalled();
});

test("a pick after the frame reloads is refused", async () => {
	const t = target();
	const { result } = setup();
	act(() => result.current.start(t));
	act(() => result.current.stop());
	send(picked());
	await settle();
	expect(t.deliver).not.toHaveBeenCalled();
	expect(result.current.state).toBe("idle");
});

test("a pick after the grant changes is refused", async () => {
	const t = target();
	const { result, rerender, options } = setup();
	act(() => result.current.start(t));
	rerender({ ...options, frameKey: "grant-2" });
	expect(result.current.state).toBe("idle");
	send(picked());
	await settle();
	expect(t.deliver).not.toHaveBeenCalled();
});

test("a pick after the preview origin changes is refused", async () => {
	const t = target();
	const { result, rerender, options } = setup();
	act(() => result.current.start(t));
	rerender({
		...options,
		previewOrigin: "https://alice-3000.preview.portikus.example.edu",
	});
	send(picked());
	await settle();
	expect(t.deliver).not.toHaveBeenCalled();
});

test("unmounting stops picking", () => {
	const post = vi.spyOn(iframe.contentWindow as Window, "postMessage");
	const { result, unmount } = setup();
	act(() => result.current.start(target()));
	unmount();
	expect(post).toHaveBeenLastCalledWith({ v: 1, type: "stop" }, ORIGIN);
});

test("the port and the time come from this page, and the names and types are fixed", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-11-19T12:00:00.000Z"));
	const t = target();
	const { result } = setup({ port: 4321 });
	act(() => result.current.start(t));
	send(picked({ png: new Uint8Array(PNG).buffer }));
	await settle();
	const [md, png] = delivered(t);
	expect(md?.name).toBe(PICK_MARKDOWN_FILE_NAME);
	expect(md?.type).toBe("text/markdown");
	expect(png?.name).toBe(PICK_PNG_FILE_NAME);
	expect(png?.type).toBe("image/png");
	const text = await md?.text();
	expect(text).toContain("- Preview port: 4321");
	expect(text).toContain("- Captured: 2026-11-19T12:00:00.000Z");
	expect(text).toContain(`- Screenshot: ${PICK_PNG_FILE_NAME}`);
});

test("a screenshot that is not a PNG is dropped and the file says so", async () => {
	const t = target();
	const { result } = setup();
	act(() => result.current.start(t));
	send(picked({ png: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer }));
	await settle();
	const files = delivered(t);
	expect(files).toHaveLength(1);
	expect(await files[0]?.text()).toContain("was not a PNG");
});

test("a screenshot over the size limit drops only the picture", async () => {
	const t = target();
	const { result } = setup();
	act(() => result.current.start(t));
	const big = new Uint8Array(PICK_PNG_MAX_BYTES + 1);
	big.set(PNG.slice(0, 8));
	send(picked({ png: big.buffer }));
	await settle();
	// Only the picture is dropped; the pick still goes, and says why.
	const files = delivered(t);
	expect(files).toHaveLength(1);
	expect(await files[0]?.text()).toContain("larger than the allowed size");
});

test("a pick without a screenshot says none was sent", async () => {
	const t = target();
	const { result } = setup();
	act(() => result.current.start(t));
	send(picked());
	await settle();
	const files = delivered(t);
	expect(files).toHaveLength(1);
	expect(await files[0]?.text()).toContain("did not send one");
});

test("delivery goes to the chosen target only", async () => {
	const first = target("t1");
	const second = target("t2");
	const { result } = setup();
	act(() => result.current.start(second));
	send(picked());
	await settle();
	expect(second.deliver).toHaveBeenCalledTimes(1);
	expect(first.deliver).not.toHaveBeenCalled();
});

test("a failed delivery reports the error and leaves pick mode", async () => {
	const t = target();
	const failure = new Error("upload refused");
	t.deliver.mockRejectedValueOnce(failure);
	const { result, options } = setup();
	act(() => result.current.start(t));
	send(picked());
	await settle();
	expect(options.onError).toHaveBeenCalledWith(failure);
	expect(options.onDelivered).not.toHaveBeenCalled();
	expect(result.current.state).toBe("idle");
});

test("a delivery that does not arrive leaves the view where it is", async () => {
	const t = target();
	t.deliver.mockResolvedValueOnce(false);
	const { result, options } = setup();
	act(() => result.current.start(t));
	send(picked());
	await settle();
	expect(t.deliver).toHaveBeenCalledTimes(1);
	expect(options.onDelivered).not.toHaveBeenCalled();
	expect(options.onError).not.toHaveBeenCalled();
	expect(result.current.state).toBe("idle");
});

test("picking stops when the chosen agent's pane closes", () => {
	const t = target();
	const post = vi.spyOn(iframe.contentWindow as Window, "postMessage");
	const { result } = setup();
	act(() => result.current.start(t));
	expect(result.current.state).toBe("picking");
	act(() => offs.shift()?.());
	expect(result.current.state).toBe("idle");
	expect(post).toHaveBeenLastCalledWith({ v: 1, type: "stop" }, ORIGIN);
});

test("a pick for an agent that is no longer listed is not delivered", async () => {
	const t = target();
	const { result } = setup();
	act(() => result.current.start(t));
	// Taken off the list without a render in between.
	offs.shift()?.();
	send(picked());
	await settle();
	expect(t.deliver).not.toHaveBeenCalled();
	expect(result.current.state).toBe("idle");
});

test("nothing starts without a frame to pick from", () => {
	const { result } = setup({ previewOrigin: null });
	act(() => result.current.start(target()));
	expect(result.current.state).toBe("idle");
});
