import { type FocusEvent, type ReactNode, useEffect, useRef } from "react";
import { AdminGroup } from "../AdminSection.js";

/**
 * Catches focus when a finished delete removes the focused row, such as its
 * Deleting button, and puts it on the element `target` returns instead.
 */
export function useFocusCatch(target: () => HTMLElement | null) {
	const focused = useRef<HTMLElement | null>(null);
	useEffect(() => {
		const last = focused.current;
		if (!last || last.isConnected) return;
		focused.current = null;
		const active = document.activeElement;
		if (active === null || active === document.body) target()?.focus();
	});
	return (event: FocusEvent<HTMLElement>) => {
		focused.current = event.target;
	};
}

/** An `AdminGroup` whose heading takes focus when a removed row had it. */
export function Group(props: Parameters<typeof AdminGroup>[0]) {
	const onFocus = useFocusCatch(() => document.getElementById(props.id));
	return (
		// `contents` keeps the card a direct child of the tab's gap layout.
		// biome-ignore lint/a11y/noStaticElementInteractions: only notes which child had focus
		<div className="contents" onFocus={onFocus}>
			<AdminGroup {...props} />
		</div>
	);
}

/** A titled part inside a group, with an h4. */
export function Part({
	id,
	title,
	help,
	children,
	testId,
}: {
	id: string;
	title: string;
	help?: ReactNode;
	children: ReactNode;
	testId?: string;
}) {
	const heading = useRef<HTMLHeadingElement>(null);
	const onFocus = useFocusCatch(() => heading.current);
	return (
		<section
			className="grid gap-3"
			aria-labelledby={id}
			data-testid={testId}
			onFocus={onFocus}
		>
			<div className="flex items-center gap-1">
				<h4
					className="pk-text-compact m-0 font-semibold text-ink-muted"
					id={id}
					ref={heading}
					tabIndex={-1}
				>
					{title}
				</h4>
				{help}
			</div>
			{children}
		</section>
	);
}

/** A table, or one line of text in its place when there is nothing to list. */
export function Table({
	testId,
	caption,
	headers,
	empty,
	children,
}: {
	testId: string;
	caption: string;
	/** Column names; "" for the actions column, or a name with its toggletip. */
	headers: (string | { name: string; help: ReactNode })[];
	empty: string | null;
	children: ReactNode;
}) {
	if (empty !== null) {
		return (
			<p className="pk-muted m-0 text-[13px]" data-testid={`${testId}-empty`}>
				{empty}
			</p>
		);
	}
	return (
		<div className="pk-table-wrap">
			<table className="pk-table" data-testid={testId}>
				<caption className="sr-only">{caption}</caption>
				<thead>
					<tr>
						{headers.map((header) =>
							typeof header === "string" ? (
								<th key={header} scope="col">
									{header || <span className="sr-only">Actions</span>}
								</th>
							) : (
								<th key={header.name} scope="col">
									<span className="inline-flex items-center gap-1">
										{header.name}
										{header.help}
									</span>
								</th>
							),
						)}
					</tr>
				</thead>
				<tbody>{children}</tbody>
			</table>
		</div>
	);
}
