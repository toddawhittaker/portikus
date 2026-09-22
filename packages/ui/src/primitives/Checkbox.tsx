import type * as React from "react";
import { cx } from "./cx.js";
import { Icon } from "./Icon.js";
import { HINT_CLASS } from "./TextField.js";

export interface CheckboxProps {
	label: React.ReactNode;
	description?: React.ReactNode;
	checked?: boolean;
	disabled?: boolean;
	onChange?: React.ChangeEventHandler<HTMLInputElement>;
	className?: string;
}

/**
 * A native checkbox inside its label: the whole label is the hit target and the
 * keyboard behaviour is the browser's. The visible box is a sibling span so it can
 * follow the input's checked and focus state.
 */
export function Checkbox({
	label,
	description,
	checked,
	disabled,
	onChange,
	className,
}: CheckboxProps): React.ReactElement {
	return (
		<label
			className={cx("pk-check inline-flex cursor-pointer items-start gap-2", className)}
		>
			<input
				type="checkbox"
				className="peer absolute size-px opacity-0"
				checked={checked}
				disabled={disabled}
				onChange={onChange}
				readOnly={onChange ? undefined : true}
			/>
			<span
				className="pk-check-box mt-0.5 grid size-4 flex-none place-items-center rounded-xs border border-line-strong bg-surface-raised text-on-accent peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:outline peer-focus-visible:outline-[length:var(--ring-width)] peer-focus-visible:outline-offset-[var(--ring-offset)] peer-focus-visible:outline-focus"
				aria-hidden={true}
			>
				{checked ? <Icon name="check" size="sm" /> : null}
			</span>
			<span className="pk-checkbox-copy">
				<span>{label}</span>
				{description ? <span className={HINT_CLASS}>{description}</span> : null}
			</span>
		</label>
	);
}
