import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * A table's box. Where the table is wider than its place the box scrolls
 * sideways, and only then is it a named region that takes focus, so the
 * keyboard can scroll it (SPEC.md section 25.8, WCAG 2.1.1) without adding a
 * tab stop to every table that fits.
 */
export function TableBox({ label, children }: { label: string; children: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	const [scrolls, setScrolls] = useState(false);
	useEffect(() => {
		const box = ref.current;
		if (!box || typeof ResizeObserver === "undefined") return;
		const check = () => setScrolls(box.scrollWidth > box.clientWidth + 1);
		const observer = new ResizeObserver(check);
		observer.observe(box);
		if (box.firstElementChild) observer.observe(box.firstElementChild);
		check();
		return () => observer.disconnect();
	}, []);
	const region = scrolls ? { role: "region", "aria-label": label, tabIndex: 0 } : {};
	return (
		<div ref={ref} className="pk-table-wrap" {...region}>
			{children}
		</div>
	);
}
