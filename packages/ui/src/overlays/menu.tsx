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
	/** Before focus returns to the trigger. preventDefault to leave it. */
	onCloseAutoFocus?: (event: Event) => void;
}

/** The styled menu surface: Radix Content inside its Portal. */
export function Menu({
	label,
	children,
	className,
	style,
	onCloseAutoFocus,
}: MenuProps): React.ReactElement {
	const kind = React.useContext(MenuKindContext);
	const P = parts(kind);
	const content = (
		<P.Content
			aria-label={label}
			className={`pk-menu min-w-50 rounded-md border border-line bg-surface-raised p-1 shadow-md ${className ?? ""}`}
			style={style}
			sideOffset={kind === "dropdown" ? 4 : undefined}
			onCloseAutoFocus={onCloseAutoFocus}
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
	onSelect?: () => void;
	/** When set, the item is a link rather than a button. */
	href?: string;
	target?: string;
	rel?: string;
	/** The file name a link item saves to, for a download link. */
	download?: string;
	testId?: string;
	children?: React.ReactNode;
}

export function MenuItem({
	icon,
	shortcut,
	danger,
	disabled,
	onSelect,
	href,
	target,
	rel,
	download,
	testId,
	children,
}: MenuItemProps): React.ReactElement {
	const P = parts(React.useContext(MenuKindContext));
	const inner = (
		<>
			{icon ? <Icon name={icon} size="sm" /> : null}
			<span className="pk-menu-item-label flex-1">{children}</span>
			{shortcut ? (
				<span aria-hidden="true">
					<ShortcutHint className="pk-menu-item-shortcut" keys={shortcut} plain />
				</span>
			) : null}
		</>
	);
	return (
		<P.Item
			asChild={href !== undefined}
			className={href === undefined ? itemClass(danger) : undefined}
			disabled={disabled}
			aria-keyshortcuts={shortcut ? keyShortcuts(shortcut) : undefined}
			onSelect={onSelect}
			data-testid={href === undefined ? testId : undefined}
		>
			{href === undefined ? (
				inner
			) : (
				<a
					href={href}
					target={target}
					rel={rel}
					download={download}
					className={itemClass(danger)}
					data-testid={testId}
				>
					{inner}
				</a>
			)}
		</P.Item>
	);
}

export interface MenuCheckboxItemProps {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	testId?: string;
	children?: React.ReactNode;
}

/** An on/off item: a menu item the keyboard reaches, not a form checkbox. */
export function MenuCheckboxItem({
	checked,
	onCheckedChange,
	testId,
	children,
}: MenuCheckboxItemProps): React.ReactElement {
	const P = parts(React.useContext(MenuKindContext));
	return (
		<P.CheckboxItem
			className={itemClass(false)}
			checked={checked}
			onCheckedChange={(value) => onCheckedChange(value === true)}
			data-testid={testId}
		>
			<span className="grid size-[var(--size-icon-sm)] place-items-center">
				<P.ItemIndicator>
					<Icon name="check" size="sm" />
				</P.ItemIndicator>
			</span>
			<span className="pk-menu-item-label flex-1">{children}</span>
		</P.CheckboxItem>
	);
}

function itemClass(danger: boolean | undefined): string {
	return `pk-menu-item ${danger ? "pk-menu-item--danger" : ""}`;
}

/** The aria-keyshortcuts spelling of a shortcut ("Control+Alt+T"). */
function keyShortcuts(keys: Key[]): string {
	return keys.map((key) => (key === "Mod" ? "Control" : key)).join("+");
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
