import { useEffect, useState } from "react";
import { SECTIONS } from "./sections.js";

/** How far down the window a section's top must pass to become the current one. */
const CURRENT_LINE = 0.45;

/**
 * The section whose top has passed the upper part of the window, followed as
 * the pane scrolls. It looks the cards up on every check, so sections that
 * render after their settings load are followed too.
 */
export function currentSection(line: number): string | null {
	let current: string | null = null;
	for (const section of Object.values(SECTIONS)) {
		const card = document.querySelector(`[data-testid="${section.id}"]`);
		if (!card) continue;
		if (card.getBoundingClientRect().top > line) break;
		current = section.id;
	}
	return current;
}

function useCurrentSection(): string | null {
	const [current, setCurrent] = useState<string | null>(null);
	useEffect(() => {
		let frame = 0;
		const check = () => {
			frame = 0;
			setCurrent(currentSection(window.innerHeight * CURRENT_LINE));
		};
		// Scroll events do not bubble; the capture phase sees the pane's own.
		const onScroll = () => {
			if (frame === 0) frame = requestAnimationFrame(check);
		};
		document.addEventListener("scroll", onScroll, { capture: true, passive: true });
		check();
		return () => {
			document.removeEventListener("scroll", onScroll, { capture: true });
			cancelAnimationFrame(frame);
		};
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
			className="sticky top-0 z-[2] -mx-4 bg-surface px-4 py-2 max-[35rem]:mx-0 max-[35rem]:px-0 @min-[62rem]/settings:top-4 @min-[62rem]/settings:mx-0 @min-[62rem]/settings:self-start @min-[62rem]/settings:bg-transparent @min-[62rem]/settings:px-0 @min-[62rem]/settings:py-0"
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
