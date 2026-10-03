import { hideOthers } from "aria-hidden";

/**
 * Keeps a modal's page hidden from screen readers as it changes. Radix hides
 * the page once, when the modal opens, and leaves the ancestors of every
 * `aria-live` region exposed so announcements are still heard; anything that
 * mounts beside those regions later would be exposed behind the modal
 * (SPEC.md §25.8). On such a change this hides the page again, keeping the
 * live regions. Layers opened after the modal, such as a popover or an alert
 * dialog over it, portal to new children of the body and are left alone.
 * Returns the cleanup, for use from a React ref callback.
 */
export function hideLateContent(content: HTMLElement): () => void {
	const portal = topLevel(content);
	const page = new Set([...document.body.children].filter((child) => child !== portal));
	let undo: (() => void) | null = null;
	let frame = 0;

	function exposed(node: Node): boolean {
		if (!(node instanceof Element) || content.contains(node)) return false;
		// Inside a live region the page keeps exposed, it is meant to be heard.
		if (node.parentElement?.closest("[aria-live]")) return false;
		const top = topLevel(node);
		return (
			top !== null && page.has(top) && node.closest('[aria-hidden="true"]') === null
		);
	}

	function rehide() {
		frame = 0;
		if (!content.isConnected) return;
		undo?.();
		// The modal and every layer opened since stay visible; the page does not.
		const layers = [...document.body.children].filter((child) => !page.has(child));
		undo = hideOthers([content, ...layers]);
	}

	const observer = new MutationObserver((records) => {
		if (frame) return;
		if (records.some((record) => [...record.addedNodes].some(exposed))) {
			frame = requestAnimationFrame(rehide);
		}
	});
	observer.observe(document.body, { childList: true, subtree: true });

	return () => {
		observer.disconnect();
		if (frame) cancelAnimationFrame(frame);
		undo?.();
	};
}

/** The child of the body that holds the node, or null outside the body. */
function topLevel(node: Element): Element | null {
	let current: Element | null = node;
	while (current && current.parentElement !== document.body) {
		current = current.parentElement;
	}
	return current;
}
