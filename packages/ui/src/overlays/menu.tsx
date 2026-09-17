import * as RadixContextMenu from "@radix-ui/react-context-menu";
import * as RadixDropdownMenu from "@radix-ui/react-dropdown-menu";
import * as React from "react";
import { Icon, type IconName, type Key, ShortcutHint } from "../primitives/index.js";

/** Which Radix family the items below render into. */
const MenuKindContext = React.createContext<"dropdown" | "context">("dropdown");

// The two Radix menu families have the same part names and props, so one set of
// item components can serve both.
function parts(kind: "dropdown" | "context") {
	return kind === "context" ? RadixContextMenu : RadixDropdownMenu;
}

export const MenuRoot = RadixDropdownMenu.Root;
export const MenuTrigger = RadixDropdownMenu.Trigger;

export interface ContextMenuProps {
	children?: React.ReactNode;
	onOpenChange?: (open: boolean) => void;
}

/** Root of the right-click variant. Everything inside it renders Radix ContextMenu parts. */
export function ContextMenu({
	children,
	onOpenChange,
}: ContextMenuProps): React.ReactElement {
	return (
		<MenuKindContext.Provider value="context">
			<RadixContextMenu.Root onOpenChange={onOpenChange}>
				{children}
			</RadixContextMenu.Root>
		</MenuKindContext.Provider>
	);
}

export const ContextMenuTrigger = RadixContextMenu.Trigger;

export interface MenuProps {
	label?: string;
	children?: React.ReactNode;
	className?: string;
	style?: React.CSSProperties;
}

/** The styled menu surface: Radix Content inside its Portal. */
export function Menu({
	label,
	children,
	className,
	style,
}: MenuProps): React.ReactElement {
	const kind = React.useContext(MenuKindContext);
	const P = parts(kind);
	const content = (
		<P.Content
			aria-label={label}
			className={`pk-menu min-w-50 rounded-md border border-line bg-surface-raised p-1 shadow-md ${className ?? ""}`}
			style={style}
			sideOffset={kind === "dropdown" ? 4 : undefined}
		>
			{children}
		</P.Content>
	);
	return <P.Portal>{content}</P.Portal>;
}

export interface MenuItemProps {
	icon?: IconName;
	shortcut?: Key[];
	danger?: boolean;
	disabled?: boolean;
	/** Preview only: render the item as if the keyboard were on it. */
	highlighted?: boolean;
	onSelect?: () => void;
	children?: React.ReactNode;
}

export function MenuItem({
	icon,
	shortcut,
	danger,
	disabled,
	highlighted,
	onSelect,
	children,
}: MenuItemProps): React.ReactElement {
	const P = parts(React.useContext(MenuKindContext));
	return (
		<P.Item
			className={`pk-menu-item ${danger ? "pk-menu-item--danger" : ""}`}
			disabled={disabled}
			data-highlighted={highlighted ? "" : undefined}
			onSelect={onSelect}
		>
			{icon ? <Icon name={icon} size="sm" /> : null}
			<span className="pk-menu-item-label flex-1">{children}</span>
			{shortcut ? (
				<ShortcutHint className="pk-menu-item-shortcut" keys={shortcut} plain />
			) : null}
		</P.Item>
	);
}

export function MenuSeparator(): React.ReactElement {
	const P = parts(React.useContext(MenuKindContext));
	return <P.Separator className="pk-menu-sep" />;
}

export interface MenuLabelProps {
	children?: React.ReactNode;
}

export function MenuLabel({ children }: MenuLabelProps): React.ReactElement {
	const P = parts(React.useContext(MenuKindContext));
	return (
		<P.Label className="px-2 py-1 text-xs font-medium text-ink-muted">
			{children}
		</P.Label>
	);
}
