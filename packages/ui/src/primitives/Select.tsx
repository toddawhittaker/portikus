import * as RadixSelect from "@radix-ui/react-select";
import type * as React from "react";
import { cx } from "./cx.js";
import { Icon } from "./Icon.js";
import { CONTROL_CLASS, FIELD_CLASS, HINT_CLASS, LABEL_CLASS } from "./TextField.js";

export interface SelectOption {
	value: string;
	label: string;
}

/** A named set of options, shown under its heading in the list. */
export interface SelectGroup {
	label: string;
	options: SelectOption[];
}

export interface SelectProps {
	id: string;
	label: React.ReactNode;
	options?: SelectOption[];
	/** Options under headings. Shown after the ungrouped `options`. */
	groups?: SelectGroup[];
	value?: string;
	placeholder?: string;
	hint?: React.ReactNode;
	/** Render the list open; used by previews and tests. */
	open?: boolean;
	/** Show the value but take no choice, while the options are still coming. */
	disabled?: boolean;
	onValueChange?: (v: string) => void;
}

function Option({ option }: { option: SelectOption }): React.ReactElement {
	return (
		<RadixSelect.Item
			value={option.value}
			className="pk-menu-item flex h-[var(--pk-row)] cursor-default select-none items-center gap-2 rounded-sm px-2 text-ink outline-none data-[highlighted]:bg-surface-hover"
		>
			<RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
		</RadixSelect.Item>
	);
}

export function Select({
	id,
	label,
	options = [],
	groups = [],
	value,
	placeholder,
	hint,
	open,
	disabled,
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
				disabled={disabled}
				onValueChange={onValueChange}
			>
				<RadixSelect.Trigger
					id={id}
					aria-labelledby={`${id}-l ${id}`}
					className={cx(
						"pk-select flex cursor-pointer items-center justify-between gap-2 text-left",
						disabled ? "cursor-default opacity-60" : "",
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
						className="pk-menu min-w-[200px] rounded-md border border-line bg-surface-raised p-1 shadow-md"
					>
						<RadixSelect.Viewport className="max-h-[18rem] overflow-y-auto">
							{options.map((option) => (
								<Option key={option.value} option={option} />
							))}
							{groups.map((group) => (
								<RadixSelect.Group key={group.label}>
									<RadixSelect.Label className="pk-text-caption px-2 py-1 text-ink-muted">
										{group.label}
									</RadixSelect.Label>
									{group.options.map((option) => (
										<Option key={option.value} option={option} />
									))}
								</RadixSelect.Group>
							))}
						</RadixSelect.Viewport>
					</RadixSelect.Content>
				</RadixSelect.Portal>
			</RadixSelect.Root>
			{hint ? <p className={HINT_CLASS}>{hint}</p> : null}
		</div>
	);
}
