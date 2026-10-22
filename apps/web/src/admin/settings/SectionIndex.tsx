import { SECTIONS } from "./sections.js";

/**
 * Links to each section. A column that stays in view beside the sections on
 * a wide page, and a wrapped row of links above them on a narrow one.
 */
export function SectionIndex() {
	return (
		<nav
			aria-label="Settings sections"
			className="@min-[62rem]/settings:sticky @min-[62rem]/settings:top-0 @min-[62rem]/settings:self-start"
		>
			<ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 @min-[62rem]/settings:flex-col">
				{Object.values(SECTIONS).map((section) => (
					<li key={section.id}>
						<a
							className="pk-focus-ring inline-flex min-h-6 items-center rounded-sm text-[length:var(--pk-font)] text-ink-muted no-underline hover:text-ink hover:underline"
							href={`#${section.id}`}
						>
							{section.title}
						</a>
					</li>
				))}
			</ul>
		</nav>
	);
}
