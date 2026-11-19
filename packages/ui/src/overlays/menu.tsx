import * as RadixContextMenu from "@radix-ui/react-context-menu";
import * as RadixDropdownMenu from "@radix-ui/react-dropdown-menu";
import * as React from "react";
import { Icon, type IconName, type Key, ShortcutHint } from "../primitives/index.js";
import { skipTooltipOnReturnedFocus } from "../primitives/Tooltip.js";

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
	/** Which edge of the trigger a dropdown lines up with. */
	align?: "start" | "center" | "end";
}

/** The styled menu surface: Radix Content inside its Portal. */
export function Menu({
	label,
	children,
	className,
	style,
	onCloseAutoFocus,
	align,
}: MenuProps): React.ReactElement {
	const kind = React.useContext(MenuKindContext);
	const P = parts(kind);
	const content = (
		<P.Content
			aria-label={label}
			className={`pk-menu min-w-50 rounded-md border border-line bg-surface-raised p-1 shadow-md ${className ?? ""}`}
			style={style}
			sideOffset={kind === "dropdown" ? 4 : undefined}
			align={kind === "dropdown" ? align : undefined}
			// Keep the menu off the window edge.
			collisionPadding={8}
			onCloseAutoFocus={(event) => {
				onCloseAutoFocus?.(event);
				// Radix focuses the trigger next; its tooltip would cover a neighbour.
				if (!event.defaultPrevented) skipTooltipOnReturnedFocus();
			}}
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
	/**
	 * Shown and reachable but does nothing for now, such as while a request
	 * runs: aria-disabled, so the keyboard does not skip it (SPEC.md section 25.8).
	 */
	unavailable?: boolean;
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
	unavailable,
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
			// Passed last by Radix, so it must carry `disabled` too.
			aria-disabled={unavailable || disabled || undefined}
			aria-keyshortcuts={shortcut ? keyShortcuts(shortcut) : undefined}
			onSelect={
				unavailable
					? // Kept open, so the press visibly does nothing.
						(event) => event.preventDefault()
					: onSelect
			}
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
			<span className="pk-menu-check grid size-[var(--size-icon-sm)] place-items-center">
				<P.ItemIndicator>
					<Icon name="check" size="sm" />
				</P.ItemIndicator>
			</span>
			<span className="pk-menu-item-label flex-1">{children}</span>
		</P.CheckboxItem>
	);
}

export interface MenuRadioGroupProps {
	/** The group's accessible name, usually the text of the `MenuLabel` above it. */
	label: string;
	value: string;
	onValueChange: (value: string) => void;
	children?: React.ReactNode;
}

/** A set of items of which exactly one is chosen, such as a width. */
export function MenuRadioGroup({
	label,
	value,
	onValueChange,
	children,
}: MenuRadioGroupProps): React.ReactElement {
	const P = parts(React.useContext(MenuKindContext));
	return (
		<P.RadioGroup aria-label={label} value={value} onValueChange={onValueChange}>
			{children}
		</P.RadioGroup>
	);
}

export interface MenuRadioItemProps {
	value: string;
	/** A second, quieter line under the label, such as what the choice costs. */
	description?: React.ReactNode;
	/**
	 * Shown and reachable but cannot be chosen, such as a choice that comes
	 * later: aria-disabled, so the keyboard does not skip it (SPEC.md section 25.8).
	 */
	unavailable?: boolean;
	testId?: string;
	children?: React.ReactNode;
}

/** One choice in a `MenuRadioGroup`, marked with the checkbox item's tick. */
export function MenuRadioItem({
	value,
	description,
	unavailable,
	testId,
	children,
}: MenuRadioItemProps): React.ReactElement {
	const P = parts(React.useContext(MenuKindContext));
	const id = React.useId();
	const described = description !== undefined;
	const content = (
		<>
			<span className="pk-menu-check grid size-[var(--size-icon-sm)] place-items-center">
				<P.ItemIndicator>
					<Icon name="check" size="sm" />
				</P.ItemIndicator>
			</span>
			{described ? (
				<span className="pk-menu-item-text">
					<span id={`${id}-label`} className="pk-menu-item-label">
						{children}
					</span>
					<span id={`${id}-description`} className="pk-menu-item-description">
						{description}
					</span>
				</span>
			) : (
				<span className="pk-menu-item-label flex-1">{children}</span>
			)}
		</>
	);
	const shared = {
		className: `${itemClass(false)}${described ? " pk-menu-item--described" : ""}`,
		"aria-labelledby": described ? `${id}-label` : undefined,
		"aria-describedby": described ? `${id}-description` : undefined,
		"data-testid": testId,
	};
	if (unavailable) {
		// A plain item: a Radix radio item sets the group's value even when its select is cancelled.
		return (
			<P.Item
				{...shared}
				role="menuitemradio"
				aria-checked={false}
				aria-disabled={true}
				onSelect={(event) => event.preventDefault()}
			>
				{content}
			</P.Item>
		);
	}
	return (
		<P.RadioItem {...shared} value={value}>
			{content}
		</P.RadioItem>
	);
}

export interface MenuSubProps {
	/** The text of the item that opens the submenu; it also names the submenu. */
	label: string;
	disabled?: boolean;
	testId?: string;
	children?: React.ReactNode;
}

/** An item that opens a nested menu, such as a list of places to move to. */
export function MenuSub({
	label,
	disabled,
	testId,
	children,
}: MenuSubProps): React.ReactElement {
	const P = parts(React.useContext(MenuKindContext));
	const [open, setOpen] = React.useState(false);
	const trigger = React.useRef<HTMLDivElement | null>(null);
	return (
		<P.Sub open={open} onOpenChange={setOpen}>
			<P.SubTrigger
				ref={trigger}
				className={`${itemClass(false)} pk-menu-subtrigger`}
				disabled={disabled}
				data-testid={testId}
			>
				<span className="pk-menu-item-label flex-1">{label}</span>
				{/* Wrapped, so the menu's icon gutter still applies to this item. */}
				<span aria-hidden="true" className="grid place-items-center">
					<Icon name="chevron-right" size="sm" />
				</span>
			</P.SubTrigger>
			<P.Portal>
				<P.SubContent
					aria-label={label}
					className="pk-menu min-w-50 rounded-md border border-line bg-surface-raised p-1 shadow-md"
					sideOffset={4}
					collisionPadding={8}
					// Escape steps back to the parent menu rather than closing both.
					onEscapeKeyDown={(event) => {
						event.preventDefault();
						setOpen(false);
						trigger.current?.focus();
					}}
				>
					{children}
				</P.SubContent>
			</P.Portal>
		</P.Sub>
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
