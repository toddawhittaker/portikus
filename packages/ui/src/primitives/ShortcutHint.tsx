import type * as React from "react";
import { cx } from "./cx.js";

/** `Mod` is Command on macOS and Control elsewhere. */
export type Key = "Mod" | "Alt" | "Shift" | "Ctrl" | "Enter" | string;

const KEYMAP: Record<"mac" | "other", Record<string, string>> = {
	mac: { Mod: "⌘", Alt: "⌥", Shift: "⇧", Ctrl: "⌃", Enter: "↵" },
	other: { Mod: "Ctrl", Alt: "Alt", Shift: "Shift", Ctrl: "Ctrl", Enter: "Enter" },
};

export interface ShortcutHintProps {
	keys: Key[];
	platform?: "mac" | "other";
	/** Drops the keycap outline, for use inside menus and tooltips. */
	plain?: boolean;
	className?: string;
}

export function ShortcutHint({
	keys,
	platform = "other",
	plain,
	className,
}: ShortcutHintProps): React.ReactElement {
	const map = KEYMAP[platform];
	const spoken = keys
		.join(" ")
		.replaceAll("Mod", platform === "mac" ? "Command" : "Control");
	return (
		// One spoken label for the whole group; role="img" keeps the caps out of it.
		<span
			className={cx("pk-shortcut inline-flex items-center gap-0.5", className)}
			role="img"
			aria-label={`Shortcut: ${spoken}`}
		>
			{keys.map((key, i) => (
				<kbd
					// A shortcut is a fixed list of keys that may repeat, so position is
					// the only identity a cap has.
					// biome-ignore lint/suspicious/noArrayIndexKey: see above
					key={`${key}-${i}`}
					className={cx(
						"pk-kbd box-border inline-grid h-[18px] place-items-center rounded-xs font-sans font-medium leading-none text-ink-muted",
						plain
							? "min-w-0 border border-transparent bg-transparent px-px text-[12px]"
							: "min-w-[18px] border border-line-strong bg-surface-raised px-1 text-[11px]",
					)}
				>
					{map[key] ?? key}
				</kbd>
			))}
		</span>
	);
}
