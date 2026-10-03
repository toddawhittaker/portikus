import type { ReactNode } from "react";

/** One h4 part of the Allow-list group, styled as the Backups tab's parts. */
export function Part({
	id,
	title,
	help,
	description,
	actions,
	children,
}: {
	id: string;
	title: string;
	help?: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="grid gap-3" aria-labelledby={id}>
			<div className="flex flex-wrap items-start gap-x-4 gap-y-2">
				<div className="grid min-w-0 flex-1 gap-1">
					<div className="flex items-center gap-1">
						<h4
							className="pk-text-compact m-0 font-semibold text-ink-muted"
							id={id}
							tabIndex={-1}
						>
							{title}
						</h4>
						{help}
					</div>
					{description ? (
						<p className="pk-muted m-0 text-[13px]">{description}</p>
					) : null}
				</div>
				{actions}
			</div>
			{children}
		</section>
	);
}
