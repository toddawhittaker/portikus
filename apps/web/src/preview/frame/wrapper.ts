import {
	PICK_MESSAGE_VERSION,
	parseParentMessage,
	type WrapperMessage,
} from "../pick/messages.js";
import { PREVIEW_FRAME_ALLOW } from "../previewAllow.js";
import { capturePick } from "./capture.js";
import { startPickMode } from "./overlay.js";
import { drawElement } from "./screenshot.js";

export const STANDALONE_MESSAGE =
	"This page is part of the Portikus preview and works only inside it.";

export interface WrapperOptions {
	/** Draws the picked element; replaced in unit tests, where there is no canvas. */
	draw?: (element: Element) => Promise<ArrayBuffer | undefined>;
	hoverIntervalMs?: number;
}

/**
 * Starts the preview wrapper page (BROWSER-HANDLING.md section 12.1): the
 * student's app in a full-size inner frame, and pick mode on request from
 * the Portikus page.
 */
export function startWrapper(win: Window, options: WrapperOptions = {}): void {
	const doc = win.document;
	// Opened as an ordinary page, the inner frame would run the app outside
	// the preview sandbox (SPEC.md section 24), so make none.
	if (win.parent === win) {
		const note = doc.createElement("p");
		note.className = "standalone";
		note.textContent = STANDALONE_MESSAGE;
		doc.body.append(note);
		return;
	}

	const draw = options.draw ?? drawElement;
	// The wrapper cannot know the Portikus origin, so it posts to "*". That is
	// acceptable: no message carries a secret, and the Portikus page checks
	// origin and source on its side.
	const post = (message: WrapperMessage, transfer: Transferable[] = []) =>
		win.parent.postMessage(message, "*", transfer);

	const frame = doc.createElement("iframe");
	frame.className = "app";
	frame.title = "Application";
	frame.allow = PREVIEW_FRAME_ALLOW;
	frame.src = "/";
	doc.body.append(frame);

	let leave: (() => void) | null = null;
	const cancel = () => {
		leave?.();
		leave = null;
		post({ v: PICK_MESSAGE_VERSION, type: "cancelled" });
	};

	// Pressing the Portikus pick button takes focus out of the frame, and the
	// browser then reports the app's body as focused, so the element the
	// student last focused in the app is kept here for the keyboard start.
	let lastFocused: Element | null = null;
	let loads = 0;
	frame.addEventListener("load", () => {
		loads += 1;
		lastFocused = null;
		frame.contentDocument?.addEventListener("focusin", (event) => {
			// The target is from the app's realm, so `instanceof` cannot be used.
			const target = event.target as Node | null;
			lastFocused = target?.nodeType === 1 ? (target as Element) : null;
		});
		// Pick mode holds the old document's elements; a new page ends it.
		if (loads > 1 && leave) cancel();
	});

	const onPick = async (element: Element) => {
		leave = null;
		try {
			const pick = capturePick(element);
			const png = await draw(element);
			if (png) post({ ...pick, png }, [png]);
			else post(pick);
		} catch {
			// The Portikus page is waiting in pick mode; let it leave.
			post({ v: PICK_MESSAGE_VERSION, type: "cancelled" });
		}
	};

	win.addEventListener("message", (event) => {
		if (event.source !== win.parent) return;
		const message = parseParentMessage(event.data);
		if (!message) return;
		if (message.type === "stop") {
			leave?.();
			leave = null;
			return;
		}
		if (leave || !frame.contentDocument) return;
		leave = startPickMode({
			frame,
			start: lastFocused,
			hoverIntervalMs: options.hoverIntervalMs,
			onHover: (label) => post({ v: PICK_MESSAGE_VERSION, type: "hover", label }),
			onPick: (element) => void onPick(element),
			onCancel: () => {
				leave = null;
				// A student who came from the app goes back to where they were.
				const back = lastFocused?.isConnected ? lastFocused : null;
				if (back && "focus" in back) (back as HTMLElement).focus();
				post({ v: PICK_MESSAGE_VERSION, type: "cancelled", focusInApp: back !== null });
			},
		});
	});
}
