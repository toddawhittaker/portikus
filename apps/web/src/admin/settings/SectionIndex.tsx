import { useEffect, useState } from "react";
import { SECTIONS } from "./sections.js";

/** The section nearest the top of the scrolling pane, followed as it scrolls. */
function useCurrentSection(): string | null {
	const [current, setCurrent] = useState<string | null>(null);
	useEffect(() => {
		if (typeof IntersectionObserver === "undefined") return;
		const cards = Object.values(SECTIONS)
			.map((section) => document.querySelector(`[data-testid="${section.id}"]`))
			.filter((card): card is Element => card !== null);
		const shown = new Map<string, boolean>();
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					shown.set(
						entry.target.getAttribute("data-testid") ?? "",
						entry.isIntersecting,
					);
				}
				const first = Object.values(SECTIONS).find((section) => shown.get(section.id));
				if (first) setCurrent(first.id);
			},
			{ rootMargin: "0px 0px -55% 0px" },
		);
		for (const card of cards) observer.observe(card);
		return () => observer.disconnect();
	}, []);
	return current;
}

/**
 * Links to each section, kept in view while the sections scroll: a column
 * beside them on a wide page, and on a phone one row of chips pinned to the
 * top of the pane that scrolls sideways, snapping to a whole chip and
 * fading at its far edge so a label is never cut mid-word.
 */
export function SectionIndex() {
	const current = useCurrentSection();
	return (
		<nav
			aria-label="Settings sections"
			className="sticky top-0 z-[2] -mx-4 bg-surface px-4 py-2 @min-[62rem]/settings:top-4 @min-[62rem]/settings:mx-0 @min-[62rem]/settings:self-start @min-[62rem]/settings:bg-transparent @min-[62rem]/settings:px-0 @min-[62rem]/settings:py-0"
		>
			<p className="pk-overline mb-2 hidden @min-[62rem]/settings:block">
				On this page
			</p>
			<ul className="pk-section-index m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 max-[35rem]:snap-x max-[35rem]:snap-proximity max-[35rem]:scroll-px-4 max-[35rem]:[mask-image:linear-gradient(to_right,#000_calc(100%-2.5rem),transparent)] max-[35rem]:pe-10 @min-[62rem]/settings:flex-col @min-[62rem]/settings:gap-0 @min-[62rem]/settings:border-s @min-[62rem]/settings:border-line">
				{Object.values(SECTIONS).map((section) => (
					<li key={section.id} className="max-[35rem]:snap-start">
						<a
							className="pk-focus-ring -ms-px inline-flex min-h-6 items-center rounded-sm border-s-2 border-transparent text-[13px] text-ink-muted no-underline hover:border-line-strong hover:text-ink aria-[current]:border-accent aria-[current]:font-semibold aria-[current]:text-ink @min-[62rem]/settings:min-h-8 @min-[62rem]/settings:rounded-none @min-[62rem]/settings:ps-3"
							href={`#${section.id}`}
							aria-current={current === section.id ? "location" : undefined}
						>
							{section.title}
						</a>
					</li>
				))}
			</ul>
		</nav>
	);
}
