import type * as React from "react";
import { Separator } from "react-resizable-panels";

export interface PaneHandleProps {
	orientation?: "vertical" | "horizontal";
	label?: string;
	/** Preview only: the library sets aria-valuenow itself. */
	value?: number;
	min?: number;
	max?: number;
	controls?: string;
	/** Preview only: the library sets data-separator itself. */
	state?: "inactive" | "hover" | "drag";
	className?: string;
	style?: React.CSSProperties;
	/** Called on double-click, in addition to the library's own reset. */
	onReset?: () => void;
}

/**
 * The splitter between panes. react-resizable-panels owns the aria values, the
 * arrow and Home/End keys, and the double-click reset to the default size.
 */
export function PaneHandle({
	orientation = "vertical",
	label,
	state,
	className,
	style,
	onReset,
}: PaneHandleProps): React.ReactElement {
	return (
		<Separator
			aria-label={label ?? "Resize pane"}
			data-orientation={orientation}
			data-pane-handle-state={state}
			className={`pk-handle ${className ?? ""}`}
			style={style}
			onDoubleClick={onReset}
		>
			<span className="pk-handle-grip" />
		</Separator>
	);
}
