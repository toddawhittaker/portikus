import { PICK_HOVER_LABEL_MAX_CHARS } from "../pick/messages.js";

const LABEL_TEXT_MAX_CHARS = 40;

/** What the keys do in pick mode, read out as the layer's name (SPEC.md section 25.8). */
export const PICK_LAYER_NAME =
	"Pick mode. Arrow keys move between elements: Up to the parent, Down to the first child, Left and Right to siblings. Enter picks the element, Escape leaves.";

/** Where an arrow key moves the highlight; the same element when there is nowhere to go. */
export function walk(current: Element, key: string): Element {
	switch (key) {
		case "ArrowUp":
			return current.parentElement ?? current;
		case "ArrowDown":
			return current.firstElementChild ?? current;
		case "ArrowLeft":
			return current.previousElementSibling ?? current;
		case "ArrowRight":
			return current.nextElementSibling ?? current;
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

export interface PickModeOptions {
	frame: HTMLIFrameElement;
	onHover: (label: string) => void;
	onPick: (element: Element) => void;
	onCancel: () => void;
	hoverIntervalMs?: number;
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
	const hover = throttle(options.onHover, options.hoverIntervalMs ?? 150);

	const layer = doc.createElement("div");
	layer.className = "pick-layer";
	layer.tabIndex = 0;
	layer.setAttribute("role", "application");
	layer.setAttribute("aria-label", PICK_LAYER_NAME);
	const box = doc.createElement("div");
	box.className = "pick-box";
	box.hidden = true;
	doc.body.append(layer, box);

	let current: Element | null = null;
	let done = false;

	const highlight = (element: Element | null) => {
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
		hover.push(labelFor(element));
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

	const onPointerMove = (event: MouseEvent) => highlight(elementAt(event));
	const onClick = (event: MouseEvent) => {
		event.preventDefault();
		const element = elementAt(event) ?? current;
		if (element) finish(() => options.onPick(element));
	};
	const onWheel = (event: WheelEvent) => {
		innerWindow?.scrollBy(event.deltaX, event.deltaY);
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
			highlight(next);
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
		hover.cancel();
		inner?.removeEventListener("keydown", onInnerKeyDown, true);
		layer.remove();
		box.remove();
	}

	const focused = inner?.activeElement;
	highlight(
		focused && focused !== inner?.documentElement ? focused : (inner?.body ?? null),
	);
	layer.focus();

	return () => {
		if (!done) leave();
	};
}
