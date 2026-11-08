import {
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

/** Within this many pixels of the end, the view counts as at the end. */
const AT_END_PX = 48;

/**
 * Keep a scroll box at its end while the student is there, through streamed
 * text, opened tool blocks and a growing composer; leave it alone once they
 * scroll back to read. `away` says when to offer a way back to the end, and
 * `fresh` that something new arrived while they were away.
 */
export function useFollowEnd(
	box: RefObject<HTMLElement | null>,
	content: RefObject<HTMLElement | null>,
	active: boolean,
) {
	const atEnd = useRef(true);
	const lastTop = useRef(0);
	/** Go to the end, noting where that is so the scroll event it causes is not read as scrolling up. */
	const pin = useCallback((node: HTMLElement) => {
		node.scrollTop = node.scrollHeight;
		lastTop.current = node.scrollTop;
	}, []);
	const [away, setAway] = useState(false);
	const [fresh, setFresh] = useState(false);

	const toEnd = useCallback(() => {
		const node = box.current;
		if (!node) return;
		pin(node);
		atEnd.current = true;
		setAway(false);
		setFresh(false);
	}, [box, pin]);

	const onScroll = useCallback(() => {
		const node = box.current;
		if (!node) return;
		const up = node.scrollTop < lastTop.current;
		lastTop.current = node.scrollTop;
		const end = node.scrollHeight - node.scrollTop - node.clientHeight <= AT_END_PX;
		// A scroll event can land after the content grew; only scrolling up leaves the end.
		if (!end && !up && atEnd.current) {
			pin(node);
			return;
		}
		atEnd.current = end;
		setAway(!end);
		if (end) setFresh(false);
	}, [box, pin]);

	/** New conversation arrived: followed at the end, or noted for a student reading back. */
	const arrived = useCallback(() => {
		const node = box.current;
		if (!node) return;
		if (atEnd.current) pin(node);
		else setFresh(true);
	}, [box, pin]);

	// Any change of size, the box's own or its content's, keeps the end in view.
	useEffect(() => {
		const node = box.current;
		if (!node || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			if (atEnd.current) pin(node);
		});
		observer.observe(node);
		if (content.current) observer.observe(content.current);
		return () => observer.disconnect();
	}, [box, content, pin]);

	// A tab shown again keeps its place, or its end.
	useLayoutEffect(() => {
		const node = box.current;
		if (active && node && atEnd.current) pin(node);
	}, [active, box, pin]);

	return { away, fresh, onScroll, toEnd, arrived };
}
