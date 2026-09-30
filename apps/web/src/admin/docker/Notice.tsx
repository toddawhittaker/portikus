import { Icon } from "@portikus/ui";
import type { ReactNode } from "react";

const ICON_CLASS = {
	warning: "text-status-warning",
	error: "text-status-error",
	pending: "",
} as const;

/** A notice line under a control: what will happen, or what is not right yet. */
export function Notice({
	tone,
	id,
	testId,
	children,
}: {
	tone: "warning" | "pending" | "error";
	id?: string;
	testId?: string;
	children: ReactNode;
}) {
	const fill =
		tone === "warning"
			? "bg-status-warning-soft"
			: tone === "error"
				? "bg-status-error-soft"
				: "bg-status-starting-soft";
	return (
		<p
			id={id}
			data-testid={testId}
			className={`m-0 flex items-start gap-2 rounded-sm px-3 py-2 text-[13px] text-ink ${fill}`}
		>
			<span className={`mt-0.5 flex-none ${ICON_CLASS[tone]}`}>
				{tone === "pending" ? (
					<span className="pk-spin" aria-hidden={true} />
				) : (
					<Icon name="alert" size="sm" />
				)}
			</span>
			<span className="min-w-0 flex-1">{children}</span>
		</p>
	);
}
