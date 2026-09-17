import type * as React from "react";
import { cx } from "./cx.js";
import { Icon, type IconName } from "./Icon.js";

export interface EmptyStateProps {
	icon?: IconName;
	title: React.ReactNode;
	children?: React.ReactNode;
	/** A primary Button and at most one secondary. */
	actions?: React.ReactNode;
	className?: string;
}

export function EmptyState({
	icon,
	title,
	children,
	actions,
	className,
}: EmptyStateProps): React.ReactElement {
	return (
		<div
			className={cx(
				"pk-empty mx-auto grid max-w-[400px] justify-items-center gap-2 px-6 py-12 text-center",
				className,
			)}
		>
			{icon ? (
				<div className="pk-empty-icon mb-1 grid size-10 place-items-center rounded-md bg-surface-sunken text-ink-muted">
					<Icon name={icon} size="lg" />
				</div>
			) : null}
			<h3 className="pk-empty-title m-0 text-[15px] font-semibold leading-[22px]">
				{title}
			</h3>
			{children ? <p className="pk-empty-body m-0 text-ink-muted">{children}</p> : null}
			{actions ? (
				<div className="pk-empty-actions mt-2 flex flex-wrap justify-center gap-2">
					{actions}
				</div>
			) : null}
		</div>
	);
}
