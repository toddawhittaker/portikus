import { type ReactNode, useId } from "react";

/** The frame every admin tab shares: an h2 heading row, then the tab's content (SPEC.md section 20.1). */
export function AdminSection({
	title,
	count,
	actions,
	children,
}: {
	title: string;
	count?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
}) {
	const headingId = useId();
	return (
		<section className="mt-6 flex flex-col gap-4" aria-labelledby={headingId}>
			<div className="flex items-center gap-4">
				<div className="flex items-baseline gap-3">
					<h2 className="pk-text-heading m-0" id={headingId}>
						{title}
					</h2>
					{count !== undefined ? (
						<span className="text-[13px] text-ink-muted">{count}</span>
					) : null}
				</div>
				{actions !== undefined ? (
					<div className="ml-auto flex items-center gap-2">{actions}</div>
				) : null}
			</div>
			{children}
		</section>
	);
}
