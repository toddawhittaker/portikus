import type * as React from "react";
import { Icon } from "./Icon.js";

export const HINT_CLASS = "pk-hint m-0 text-[12px] leading-4 text-ink-muted";

const MESSAGE_CLASS =
	"m-0 flex items-center gap-1 text-[12px] leading-4 [overflow-wrap:anywhere]";

export interface FieldMessagesProps {
	/** The control's id; each message's id is derived from it. */
	id: string;
	hint?: React.ReactNode;
	error?: React.ReactNode;
	/** Shown only when there is no error. */
	warning?: React.ReactNode;
}

/**
 * The control's aria-describedby: the hint first, then the error or warning,
 * so every field reads in the same order.
 */
export function fieldDescribedBy({
	id,
	hint,
	error,
	warning,
}: FieldMessagesProps): string | undefined {
	return (
		[
			hint ? `${id}-hint` : null,
			error ? `${id}-err` : null,
			!error && warning ? `${id}-warn` : null,
		]
			.filter(Boolean)
			.join(" ") || undefined
	);
}

/** The error or warning line, then the hint, under a field's control. */
export function FieldMessages({
	id,
	hint,
	error,
	warning,
}: FieldMessagesProps): React.ReactElement {
	return (
		<>
			{error ? (
				<p className={`pk-error ${MESSAGE_CLASS} text-status-error`} id={`${id}-err`}>
					<Icon name="alert" size="sm" />
					{error}
				</p>
			) : warning ? (
				<p
					className={`pk-warning ${MESSAGE_CLASS} text-status-warning`}
					id={`${id}-warn`}
				>
					<Icon name="alert" size="sm" />
					{warning}
				</p>
			) : null}
			{hint ? (
				<p className={HINT_CLASS} id={`${id}-hint`}>
					{hint}
				</p>
			) : null}
		</>
	);
}
