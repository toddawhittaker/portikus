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
	const [away, setAway] = useState(false);
	const [fresh, setFresh] = useState(false);

	const toEnd = useCallback(() => {
		const node = box.current;
		if (!node) return;
		node.scrollTop = node.scrollHeight;
		atEnd.current = true;
		setAway(false);
		setFresh(false);
	}, [box]);

	const onScroll = useCallback(() => {
		const node = box.current;
		if (!node) return;
		const end = node.scrollHeight - node.scrollTop - node.clientHeight <= AT_END_PX;
		atEnd.current = end;
		setAway(!end);
		if (end) setFresh(false);
	}, [box]);

	/** New conversation arrived: followed at the end, or noted for a student reading back. */
	const arrived = useCallback(() => {
		const node = box.current;
		if (!node) return;
		if (atEnd.current) node.scrollTop = node.scrollHeight;
		else setFresh(true);
	}, [box]);

	// Any change of size, the box's own or its content's, keeps the end in view.
	useEffect(() => {
		const node = box.current;
		if (!node || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			if (atEnd.current) node.scrollTop = node.scrollHeight;
		});
		observer.observe(node);
		if (content.current) observer.observe(content.current);
		return () => observer.disconnect();
	}, [box, content]);

	// A tab shown again keeps its place, or its end.
	useLayoutEffect(() => {
		const node = box.current;
		if (active && node && atEnd.current) node.scrollTop = node.scrollHeight;
	}, [active, box]);

	return { away, fresh, onScroll, toEnd, arrived };
}
