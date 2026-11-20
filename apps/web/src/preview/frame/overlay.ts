import { PICK_HOVER_LABEL_MAX_CHARS } from "../pick/messages.js";

const LABEL_TEXT_MAX_CHARS = 40;

/** What the keys do in pick mode, read out as the layer's name (SPEC.md section 25.8). */
export const PICK_LAYER_NAME =
	"Pick mode. Arrow keys move between elements: Up to the parent, Down to the first child, Left and Right to siblings. Enter picks the element, Escape leaves.";

/** Elements a browser never draws, whatever their styles say. */
const NEVER_DRAWN = new Set([
	"head",
	"script",
	"style",
	"template",
	"link",
	"meta",
	"title",
	"base",
	"noscript",
]);

/** Whether `element` has a box on the page that a highlight could outline. */
function isDrawn(element: Element): boolean {
	return !NEVER_DRAWN.has(element.localName) && element.getClientRects().length > 0;
}

/** `from` itself or the nearest drawn sibling after it, following `step`. */
function drawnFrom(
	from: Element | null,
	step: (element: Element) => Element | null,
): Element | null {
	for (let element = from; element; element = step(element))
		if (isDrawn(element)) return element;
	return null;
}

/**
 * Where an arrow key moves the highlight: Up stops at the body, and the
 * others skip elements with nothing drawn. The same element when there is
 * nowhere to go.
 */
export function walk(current: Element, key: string): Element {
	const next = (element: Element) => element.nextElementSibling;
	const previous = (element: Element) => element.previousElementSibling;
	switch (key) {
		case "ArrowUp":
			if (current === current.ownerDocument.body) return current;
			return current.parentElement ?? current;
		case "ArrowDown":
			return drawnFrom(current.firstElementChild, next) ?? current;
		case "ArrowLeft":
			return drawnFrom(current.previousElementSibling, previous) ?? current;
		case "ArrowRight":
			return drawnFrom(current.nextElementSibling, next) ?? current;
		default:
			return current;
	}
}

/** A short label: the tag with its id or first class, or with a little of its text. */
export function labelFor(element: Element): string {
	const tag = element.localName;
	let label = tag;
	if (element.id) label = `${tag}#${element.id}`;
	else if (element.classList[0]) label = `${tag}.${element.classList[0]}`;
	else {
		const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
		if (text) label = `${tag} "${text.slice(0, LABEL_TEXT_MAX_CHARS)}"`;
	}
	return label.slice(0, PICK_HOVER_LABEL_MAX_CHARS);
}

/** Calls `send` once the values stop coming for `restMs`, with the last one. */
export function settle(send: (label: string) => void, restMs: number) {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const cancel = () => {
		if (timer) clearTimeout(timer);
		timer = null;
	};
	return {
		push(value: string) {
			cancel();
			timer = setTimeout(() => {
				timer = null;
				send(value);
			}, restMs);
		},
		cancel,
	};
}

/** Calls `send` at most once per interval, always with the latest value. */
export function throttle(send: (label: string) => void, intervalMs: number) {
	let last = 0;
	let pending: string | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const flush = () => {
		timer = null;
		if (pending === null) return;
		last = Date.now();
		const value = pending;
		pending = null;
		send(value);
	};
	return {
		push(value: string) {
			pending = value;
			if (timer) return;
			timer = setTimeout(flush, Math.max(0, last + intervalMs - Date.now()));
		},
		cancel() {
			if (timer) clearTimeout(timer);
			timer = null;
			pending = null;
		},
	};
}

const SCROLLS = new Set(["auto", "scroll", "overlay"]);

/**
 * The element a wheel over `from` scrolls: its nearest ancestor that can
 * scroll that way, or null when only the page itself can.
 */
function scrollTarget(from: Element | null, deltaX: number, deltaY: number) {
	const view = from?.ownerDocument.defaultView;
	const root = from?.ownerDocument.documentElement;
	for (
		let element = from;
		element && element !== root;
		element = element.parentElement
	) {
		if (element === element.ownerDocument.body) break;
		const style = view?.getComputedStyle(element);
		if (!style) break;
		const down =
			deltaY !== 0 &&
			SCROLLS.has(style.overflowY) &&
			element.scrollHeight > element.clientHeight;
		const across =
			deltaX !== 0 &&
			SCROLLS.has(style.overflowX) &&
			element.scrollWidth > element.clientWidth;
		if (down || across) return element;
	}
	return null;
}

export interface PickModeOptions {
	frame: HTMLIFrameElement;
	/** Where the keyboard highlight starts; the app's focused element or its body when not given. */
	start?: Element | null;
	onHover: (label: string) => void;
	onPick: (element: Element) => void;
	onCancel: () => void;
	/** The least time between labels sent as the keyboard walks. */
	hoverIntervalMs?: number;
	/** How long the pointer rests on an element before its label is sent. */
	hoverRestMs?: number;
}

/**
 * Lays a layer over the app's frame so no click reaches the app, and lets the
 * student choose one element by pointer or keyboard. Returns a function that
 * leaves pick mode; `onPick` and `onCancel` are called at most once in all.
 */
export function startPickMode(options: PickModeOptions): () => void {
	const { frame } = options;
	const doc = frame.ownerDocument;
	const inner = frame.contentDocument;
	const innerWindow = frame.contentWindow;
	// Speech keeps up with neither a pointer sweeping the page nor a fast
	// walk, so the pointer's label waits for it to rest and the keyboard's
	// are spaced out (SPEC.md section 25.8).
	const keyHover = throttle(options.onHover, options.hoverIntervalMs ?? 150);
	const pointerHover = settle(options.onHover, options.hoverRestMs ?? 450);

	const layer = doc.createElement("div");
	layer.className = "pick-layer";
	layer.tabIndex = 0;
	layer.setAttribute("role", "application");
	layer.setAttribute("aria-label", PICK_LAYER_NAME);
	const box = doc.createElement("div");
	box.className = "pick-box";
	box.hidden = true;
	// First in the page, so Tab from the Portikus page reaches the layer
	// before the app's frame.
	doc.body.prepend(layer);
	doc.body.append(box);

	let current: Element | null = null;
	let done = false;

	/**
	 * `by` says what moved the highlight. With neither, nothing is read: the
	 * start, so the instructions are heard first, and a redraw after a scroll.
	 */
	const highlight = (element: Element | null, by?: "pointer" | "key") => {
		current = element;
		if (!element) {
			box.hidden = true;
			return;
		}
		const frameRect = frame.getBoundingClientRect();
		const rect = element.getBoundingClientRect();
		box.hidden = false;
		box.style.left = `${frameRect.left + rect.left}px`;
		box.style.top = `${frameRect.top + rect.top}px`;
		box.style.width = `${rect.width}px`;
		box.style.height = `${rect.height}px`;
		if (by === "pointer") {
			keyHover.cancel();
			pointerHover.push(labelFor(element));
		} else if (by === "key") {
			pointerHover.cancel();
			keyHover.push(labelFor(element));
		}
	};

	const elementAt = (event: MouseEvent): Element | null => {
		if (!inner) return null;
		const frameRect = frame.getBoundingClientRect();
		return inner.elementFromPoint(
			event.clientX - frameRect.left,
			event.clientY - frameRect.top,
		);
	};

	const finish = (then: () => void) => {
		if (done) return;
		leave();
		then();
	};

	const onPointerMove = (event: MouseEvent) => {
		const element = elementAt(event);
		if (element !== current) highlight(element, "pointer");
	};
	const onClick = (event: MouseEvent) => {
		event.preventDefault();
		const element = elementAt(event) ?? current;
		if (element) finish(() => options.onPick(element));
	};
	const onWheel = (event: WheelEvent) => {
		const target = scrollTarget(elementAt(event), event.deltaX, event.deltaY);
		if (target) target.scrollBy(event.deltaX, event.deltaY);
		else innerWindow?.scrollBy(event.deltaX, event.deltaY);
		// Redraw the box only; the element under it has not changed.
		if (current) highlight(current);
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			finish(options.onCancel);
		} else if (event.key === "Enter" && current) {
			event.preventDefault();
			const element = current;
			finish(() => options.onPick(element));
		} else if (event.key.startsWith("Arrow") && current) {
			event.preventDefault();
			const next = walk(current, event.key);
			next.scrollIntoView?.({ block: "nearest" });
			if (next !== current) highlight(next, "key");
		}
	};
	const onInnerKeyDown = (event: KeyboardEvent) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		finish(options.onCancel);
	};

	layer.addEventListener("mousemove", onPointerMove);
	layer.addEventListener("click", onClick);
	layer.addEventListener("wheel", onWheel, { passive: true });
	layer.addEventListener("keydown", onKeyDown);
	inner?.addEventListener("keydown", onInnerKeyDown, true);

	function leave() {
		done = true;
		keyHover.cancel();
		pointerHover.cancel();
		inner?.removeEventListener("keydown", onInnerKeyDown, true);
		layer.remove();
		box.remove();
	}

	const focused = options.start ?? inner?.activeElement;
	highlight(
		focused && focused !== inner?.documentElement && focused.isConnected
			? focused
			: (inner?.body ?? null),
	);
	layer.focus();

	return () => {
		if (!done) leave();
	};
}
