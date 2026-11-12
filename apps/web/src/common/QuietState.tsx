import type { ReactNode } from "react";
import { PorticoMark } from "./PorticoMark.js";

/**
 * A calm one-row state for a section with nothing to show: all clear, no
 * matches, or not read yet. The portico glyph marks it as a state rather than
 * help text; the title says what it means and the detail what is next.
 */
export function QuietState({
	title,
	detail,
	action,
	variant = "clear",
	testId,
}: {
	title: ReactNode;
	detail?: ReactNode;
	action?: ReactNode;
	/** `clear` for nothing wrong, `empty` for nothing to list or no matches. */
	variant?: "clear" | "empty";
	testId?: string;
}) {
	return (
		<div className="pk-quiet" data-variant={variant} data-testid={testId}>
			<span className="pk-quiet-mark">
				<PorticoMark variant={variant} size={24} />
			</span>
			<div className="pk-quiet-text">
				<p className="pk-quiet-title">{title}</p>
				{detail ? <p className="pk-quiet-detail">{detail}</p> : null}
			</div>
			{action ? <div className="pk-quiet-action">{action}</div> : null}
		</div>
	);
}
