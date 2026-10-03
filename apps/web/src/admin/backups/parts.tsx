import { type FocusEvent, type ReactNode, useEffect, useRef } from "react";
import { AdminGroup, Part as SharedPart } from "../AdminSection.js";

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

/** Puts focus on the heading `id` names when a removed row inside had it. */
function HeadingCatch({ id, children }: { id: string; children: ReactNode }) {
	const onFocus = useFocusCatch(() => document.getElementById(id));
	return (
		// `contents` keeps the card or part a direct child of its parent's gap layout.
		// biome-ignore lint/a11y/noStaticElementInteractions: only notes which child had focus
		<div className="contents" onFocus={onFocus}>
			{children}
		</div>
	);
}

/** An `AdminGroup` whose heading takes focus when a removed row had it. */
export function Group(props: Parameters<typeof AdminGroup>[0]) {
	return (
		<HeadingCatch id={props.id}>
			<AdminGroup {...props} />
		</HeadingCatch>
	);
}

/** A shared admin `Part` whose heading takes focus when a removed row had it. */
export function Part(props: Parameters<typeof SharedPart>[0]) {
	return (
		<HeadingCatch id={props.id}>
			<SharedPart {...props} />
		</HeadingCatch>
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
