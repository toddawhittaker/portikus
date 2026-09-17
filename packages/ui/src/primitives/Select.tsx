import * as RadixSelect from "@radix-ui/react-select";
import type * as React from "react";
import { cx } from "./cx.js";
import { Icon } from "./Icon.js";
import { CONTROL_CLASS, FIELD_CLASS, HINT_CLASS, LABEL_CLASS } from "./TextField.js";

export interface SelectOption {
	value: string;
	label: string;
}

export interface SelectProps {
	id: string;
	label: React.ReactNode;
	options?: SelectOption[];
	value?: string;
	placeholder?: string;
	hint?: React.ReactNode;
	/** Render the list open; used by previews and tests. */
	open?: boolean;
	onValueChange?: (v: string) => void;
}

export function Select({
	id,
	label,
	options = [],
	value,
	placeholder,
	hint,
	open,
	onValueChange,
}: SelectProps): React.ReactElement {
	return (
		<div className={FIELD_CLASS}>
			<label className={LABEL_CLASS} id={`${id}-l`} htmlFor={id}>
				{label}
			</label>
			<RadixSelect.Root
				value={value}
				open={open || undefined}
				onValueChange={onValueChange}
			>
				<RadixSelect.Trigger
					id={id}
					aria-labelledby={`${id}-l ${id}`}
					className={cx(
						"pk-select flex cursor-pointer items-center justify-between gap-2 text-left",
						CONTROL_CLASS,
					)}
				>
					<RadixSelect.Value
						placeholder={
							<span className="text-ink-faint">{placeholder ?? "Choose…"}</span>
						}
					/>
					<RadixSelect.Icon>
						<Icon name="chevron-up-down" className="text-ink-muted" />
					</RadixSelect.Icon>
				</RadixSelect.Trigger>
				<RadixSelect.Portal>
					<RadixSelect.Content
						position="popper"
						sideOffset={4}
						className="pk-menu z-[var(--z-menu)] min-w-[200px] rounded-md border border-line bg-surface-raised p-1 shadow-md"
					>
						<RadixSelect.Viewport>
							{options.map((option) => (
								<RadixSelect.Item
									key={option.value}
									value={option.value}
									className="pk-menu-item flex h-[var(--pk-row)] cursor-default select-none items-center gap-2 rounded-sm px-2 text-ink outline-none data-[highlighted]:bg-surface-hover"
								>
									<RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
								</RadixSelect.Item>
							))}
						</RadixSelect.Viewport>
					</RadixSelect.Content>
				</RadixSelect.Portal>
			</RadixSelect.Root>
			{hint ? <p className={HINT_CLASS}>{hint}</p> : null}
		</div>
	);
}
