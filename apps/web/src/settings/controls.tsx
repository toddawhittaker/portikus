import { HINT_CLASS, LABEL_CLASS } from "@portikus/ui";
import { type ReactNode, useEffect } from "react";
import type { SettingsControl } from "./sections.js";

/** Scroll the chosen control into view and move focus to it. */
export function useShowSetting(highlightId: string | null, ready: boolean) {
	useEffect(() => {
		if (!highlightId || !ready) return;
		const node = document.getElementById(`settings-control-${highlightId}`);
		if (!node) return;
		node.scrollIntoView({ block: "nearest" });
		// The field itself, not the help button that sits before it beside the label.
		const focusable =
			node.querySelector<HTMLElement>("input:not([disabled]), textarea, select") ??
			node.querySelector<HTMLElement>("button:not([disabled])");
		(focusable ?? node).focus();
	}, [highlightId, ready]);
}

export function ControlFrame({
	control,
	highlighted,
	className = "",
	children,
}: {
	control: SettingsControl;
	highlighted: boolean;
	className?: string;
	children: ReactNode;
}) {
	return (
		<div
			id={`settings-control-${control.id}`}
			tabIndex={-1}
			data-highlighted={highlighted ? "true" : "false"}
			className={`rounded-sm outline-none ${className} ${
				highlighted ? "bg-surface-selected px-2 py-2" : ""
			}`}
		>
			{children}
		</div>
	);
}

/** Two or three options, shown together. A menu hides the choices until it opens. */
export function ChoiceField({
	label,
	hint,
	name,
	value,
	options,
	onChange,
	alsoDescribedBy,
}: {
	label: string;
	hint: string;
	name: string;
	value: string;
	options: readonly { value: string; label: string }[];
	onChange: (value: string) => void;
	/** Id of a note about this field that shows only some of the time. */
	alsoDescribedBy?: string;
}) {
	return (
		<fieldset
			className="m-0 min-w-0 border-0 p-0"
			aria-describedby={
				alsoDescribedBy ? `${name}-hint ${alsoDescribedBy}` : `${name}-hint`
			}
		>
			{/* A legend is not a grid item, so the rest sits in its own grid below it. */}
			<legend className={`${LABEL_CLASS} mb-1.5 p-0`}>{label}</legend>
			<div className="grid gap-1.5">
				<div className="pk-choice">
					{options.map((option) => (
						<label key={option.value}>
							<input
								type="radio"
								name={name}
								value={option.value}
								checked={value === option.value}
								onChange={() => onChange(option.value)}
							/>
							<span>{option.label}</span>
						</label>
					))}
				</div>
				<p className={HINT_CLASS} id={`${name}-hint`}>
					{hint}
				</p>
			</div>
		</fieldset>
	);
}

export function NavButton({
	current,
	nested,
	onClick,
	children,
}: {
	current: boolean;
	nested?: boolean;
	onClick: () => void;
	children: string;
}) {
	return (
		<button
			type="button"
			aria-current={current ? "page" : undefined}
			onClick={onClick}
			className={`pk-focus-ring min-h-9 w-full rounded-sm py-1 text-left text-[14px] leading-5 text-ink ${
				nested ? "pr-2 pl-6" : "px-2"
			} ${current ? "bg-surface-selected font-medium" : "hover:bg-surface-hover"}`}
		>
			{children}
		</button>
	);
}
