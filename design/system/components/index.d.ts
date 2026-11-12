// Portikus packages/ui: the public types, emitted by tsc from packages/ui/src and joined into one file.
// Documentation only. window.Portikus holds every export below (bundle.js).
import * as React from "react";
import * as RadixAlertDialog from "@radix-ui/react-alert-dialog";
import * as RadixDialog from "@radix-ui/react-dialog";
import * as RadixContextMenu from "@radix-ui/react-context-menu";
import * as RadixDropdownMenu from "@radix-ui/react-dropdown-menu";
import * as RadixTabs from "@radix-ui/react-tabs";

// ---- Badge (packages/ui/src/primitives/Badge.tsx)
export type BadgeTone = "success" | "warning" | "danger" | "info" | "neutral" | "accent" | "agent";
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
    tone: BadgeTone;
    /** Drops the fill and the padding, for a status bar. */
    plain?: boolean;
}
/** A short status label: one height, radius and type for every status in the product. */
export declare function Badge({ tone, plain, className, ...rest }: BadgeProps): React.ReactElement;

// ---- Button (packages/ui/src/primitives/Button.tsx)
declare const VARIANT_CLASS: {
    readonly primary: "border-transparent bg-accent-fill text-on-accent-fill hover:bg-accent-fill-hover active:bg-accent-fill-active";
    readonly secondary: "bg-surface-raised text-ink border-line-strong hover:bg-surface-hover";
    readonly quiet: "border-transparent bg-transparent text-ink hover:bg-surface-hover";
    readonly danger: "border-transparent bg-danger-fill text-on-danger hover:bg-danger-hover";
    /** A row's own destructive action, such as Delete…, beside quieter ones. */
    readonly "danger-secondary": "bg-surface-raised text-status-danger border-status-danger hover:bg-status-danger-soft";
};
declare const SIZE_CLASS: {
    readonly sm: "h-[var(--size-control-sm)] px-2 text-[13px]";
    readonly md: "h-[var(--pk-control)] px-[var(--pk-pad)] text-[length:var(--pk-font)]";
    readonly lg: "h-[var(--size-control-lg)] px-5 text-[15px]";
};
/** A Button's look, for a link that leads somewhere but should read as an action. */
export declare function buttonClass(variant?: keyof typeof VARIANT_CLASS, size?: keyof typeof SIZE_CLASS): string;
export interface ButtonProps extends React.ComponentPropsWithRef<"button"> {
    variant?: keyof typeof VARIANT_CLASS;
    size?: "sm" | "md" | "lg";
    /** Keeps the label and colour, adds the spinner and aria-busy, and ignores clicks. */
    loading?: boolean;
    iconStart?: IconName;
    iconEnd?: IconName;
}
export declare function Button({ variant, size, loading, iconStart, iconEnd, className, children, onClick, ...rest }: ButtonProps): React.ReactElement;

// ---- Checkbox (packages/ui/src/primitives/Checkbox.tsx)
export interface CheckboxProps {
    label: React.ReactNode;
    description?: React.ReactNode;
    checked?: boolean;
    /** Some but not all of a group are ticked; drawn as a dash. */
    indeterminate?: boolean;
    disabled?: boolean;
    /** Unavailable but focusable: drawn muted, announced as unavailable; the caller ignores changes. */
    ariaDisabled?: boolean;
    onChange?: React.ChangeEventHandler<HTMLInputElement>;
    className?: string;
}
/**
 * A native checkbox inside its label: the whole label is the hit target and the
 * keyboard behaviour is the browser's. The visible box is a sibling span so it can
 * follow the input's checked and focus state.
 */
export declare function Checkbox({ label, description, checked, indeterminate, disabled, ariaDisabled, onChange, className, }: CheckboxProps): React.ReactElement;

// ---- EmptyState (packages/ui/src/primitives/EmptyState.tsx)
export interface EmptyStateProps {
    icon?: IconName;
    title: React.ReactNode;
    children?: React.ReactNode;
    /** A primary Button and at most one secondary. */
    actions?: React.ReactNode;
    className?: string;
}
export declare function EmptyState({ icon, title, children, actions, className, }: EmptyStateProps): React.ReactElement;

// ---- FieldMessages (packages/ui/src/primitives/FieldMessages.tsx)
export declare const HINT_CLASS = "pk-hint m-0 text-[12px] leading-4 text-ink-muted";
export interface FieldMessagesProps {
    /** The control's id; each message's id is derived from it. */
    id: string;
    hint?: React.ReactNode;
    error?: React.ReactNode;
    /** Shown only when there is no error. */
    warning?: React.ReactNode;
}
interface FieldDescribedByOptions extends FieldMessagesProps {
    /** The control has a unit beside it, in an element with id `${id}-unit`. */
    unit?: boolean;
}
/**
 * The control's aria-describedby: the unit first, so "minutes" is read right
 * after the value, then the hint, then the error or warning, so every field
 * reads in the same order (SPEC.md section 25.8).
 */
export declare function fieldDescribedBy({ id, hint, error, warning, unit, }: FieldDescribedByOptions): string | undefined;
/** The error or warning line, then the hint, under a field's control. */
export declare function FieldMessages({ id, hint, error, warning, }: FieldMessagesProps): React.ReactElement;

// ---- FileInput (packages/ui/src/primitives/FileInput.tsx)
export interface FileInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "id" | "type"> {
    id: string;
    label: React.ReactNode;
    hint?: React.ReactNode;
    error?: React.ReactNode;
}
/**
 * A native file input drawn as a Select-sized control: the picker button sits
 * flush inside the box and the chosen file's name follows it. The native
 * element keeps the keyboard, drop target and file name for free.
 */
export declare function FileInput({ id, label, hint, error, className, ...rest }: FileInputProps): React.ReactElement;

// ---- Icon (packages/ui/src/primitives/Icon.tsx)
/**
 * The outlined icon set from design/system/components/Icon, drawn on a 24 grid at
 * a 1.75 stroke. Shapes are encoded the way the design system encodes them: a
 * leading R, C or E is a rect, circle or ellipse, anything else is a path.
 */
declare const PATHS: {
    terminal: string[];
    agent: string[];
    file: string[];
    "file-code": string[];
    "file-web": string[];
    "file-style": string[];
    "file-data": string[];
    "file-markdown": string[];
    "file-image": string[];
    "file-archive": string[];
    "file-config": string[];
    "file-text": string[];
    "file-sheet": string[];
    "file-notebook": string[];
    "file-audio": string[];
    "file-video": string[];
    "file-font": string[];
    "file-lock": string[];
    "file-key": string[];
    folder: string[];
    "folder-open": string[];
    preview: string[];
    plus: string[];
    minus: string[];
    x: string[];
    pencil: string[];
    more: string[];
    "chevron-right": string[];
    "chevron-down": string[];
    "chevron-up": string[];
    "chevron-up-down": string[];
    external: string[];
    alert: string[];
    check: string[];
    bell: string[];
    info: string[];
    help: string[];
    "arrow-left": string[];
    "arrow-right": string[];
    "arrow-up": string[];
    download: string[];
    search: string[];
    play: string[];
    stop: string[];
    mic: string[];
    speaker: string[];
    restart: string[];
    lock: string[];
    grip: string[];
    storage: string[];
    trash: string[];
    "sign-out": string[];
    users: string[];
    activity: string[];
    shield: string[];
    school: string[];
    list: string[];
    "clipboard-list": string[];
    globe: string[];
    archive: string[];
    box: string[];
    layers: string[];
    settings: string[];
    "sign-in": string[];
    copy: string[];
    "map-pin": string[];
};
/**
 * Source files, and PDFs: the open-bottom page stamped with a short tag. The
 * tag is drawn as text so it stays a word, never a vendor logo.
 */
declare const TAGS: {
    readonly "file-pdf": "pdf";
    readonly "file-python": "py";
    readonly "file-java": "jv";
    readonly "file-javascript": "js";
    readonly "file-typescript": "ts";
    readonly "file-c": "c";
    readonly "file-cpp": "c++";
    readonly "file-sql": "sql";
    readonly "file-shell": "sh";
    readonly "file-go": "go";
    readonly "file-rust": "rs";
    readonly "file-csharp": "c#";
    readonly "file-ruby": "rb";
    readonly "file-php": "php";
    readonly "file-kotlin": "kt";
    readonly "file-swift": "sw";
};
export type IconName = keyof typeof PATHS | keyof typeof TAGS;
export interface IconProps {
    name: IconName;
    size?: "sm" | "md" | "lg";
    /** Set only when the icon carries meaning on its own; otherwise it is hidden. */
    label?: string;
    className?: string;
}
export declare function Icon({ name, size, label, className, }: IconProps): React.ReactElement;

// ---- IconButton (packages/ui/src/primitives/IconButton.tsx)
export interface IconButtonProps extends Omit<React.ComponentPropsWithRef<"button">, "children"> {
    icon: IconName;
    /** Required. Becomes aria-label and the tooltip text. */
    label: string;
    shortcut?: Key[];
    variant?: "quiet" | "secondary";
    size?: "sm" | "md";
    /** Render the tooltip open; used by previews and tests. */
    tooltipOpen?: boolean;
}
export declare function IconButton({ icon, label, shortcut, variant, size, tooltipOpen, className, ...rest }: IconButtonProps): React.ReactElement;

// ---- Meter (packages/ui/src/primitives/Meter.tsx)
/**
 * The accessible name: a `label` string such as "Pull cache space" that
 * matches the visible row label, or the id of that visible label.
 */
type MeterName = {
    label: string;
    "aria-labelledby"?: never;
} | {
    label?: never;
    "aria-labelledby": string;
};
export type MeterProps = MeterName & {
    value: number;
    max: number;
    /** The id of text to read after the value, such as a next step. */
    "aria-describedby"?: string;
    /** Shown beside the bar and read as its value, such as "4.1 GB of 20 GB used". */
    valueText: string;
    /** Past this value the fill turns to the warning colour and the text adds "nearly full". */
    high?: number;
    /** A value to mark with a tick, such as an automatic clear point; nearby text says what it is. */
    mark?: number;
    /**
     * Shown beside the bar instead of the full words where room is short, such
     * as "85%". The meter still reads the full words, and past `high` the alert
     * icon still shows. A control around the Meter keeps these words in its name.
     */
    shortText?: string;
    className?: string;
};
/**
 * The words a Meter shows and reads: `valueText`, plus "nearly full" past
 * `high` or "over the limit" past `max`. A control that wraps a Meter builds
 * its name from this, so the name holds the visible text.
 */
export declare function meterText({ value, max, high, valueText, }: Pick<MeterProps, "value" | "max" | "high" | "valueText">): string;
/**
 * A native meter with its value as text beside it, so the figure can be read
 * and copied (SPEC.md section 25.8). The text wraps under the bar when narrow.
 * Past `high` the text gains the alert icon and "nearly full", or "over the
 * limit" past `max`, so colour is not the only sign.
 */
export declare function Meter({ value, max, label, "aria-labelledby": labelledBy, "aria-describedby": describedBy, valueText, high, mark, shortText, className, }: MeterProps): React.ReactElement;

// ---- NameMark (packages/ui/src/primitives/NameMark.tsx)
export interface NameMarkProps {
    /** Size of the name in pixels; the mark scales with it. */
    size?: number;
    href?: string;
    markOnly?: boolean;
    className?: string;
}
export declare function NameMark({ size, href, markOnly, className, }: NameMarkProps): React.ReactElement;

// ---- PageIntro (packages/ui/src/primitives/PageIntro.tsx)
export interface PageIntroProps {
    /** Names the remembered open or closed state, such as "admin-users". */
    id: string;
    /** The line that stays visible, such as "About Users". */
    summary: string;
    /** One or two plain sentences on what the page is for. */
    children: React.ReactNode;
    /** A Help page anchor, such as "/admin/help#admin-users", opened in a new tab. */
    helpHref?: string;
    /**
     * One short line on what the page is for, always shown above the
     * disclosure. With a lead the disclosure starts closed, as the lead
     * already says what the page is for.
     */
    lead?: string;
}
/**
 * A short explanation under a page heading, remembered open or closed per
 * page in this browser. Without a lead it is open until the person closes
 * it; with one, closed until they open it.
 */
export declare function PageIntro({ id, summary, children, helpHref, lead, }: PageIntroProps): React.ReactElement;

// ---- Select (packages/ui/src/primitives/Select.tsx)
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
    /** A Toggletip, shown beside the label and never inside it. */
    help?: React.ReactNode;
    /** Render the list open; used by previews and tests. */
    open?: boolean;
    /** Show the value but take no choice, while the options are still coming. */
    disabled?: boolean;
    /** Busy: stays focusable and announced as unavailable; the caller ignores changes. */
    ariaDisabled?: boolean;
    onValueChange?: (v: string) => void;
}
export declare function Select({ id, label, options, groups, value, placeholder, hint, help, open, disabled, ariaDisabled, onValueChange, }: SelectProps): React.ReactElement;

// ---- ShortcutHint (packages/ui/src/primitives/ShortcutHint.tsx)
/** `Mod` is Command on macOS and Control elsewhere. */
export type Key = "Mod" | "Alt" | "Shift" | "Ctrl" | "Enter" | string;
export interface ShortcutHintProps {
    keys: Key[];
    platform?: "mac" | "other";
    /** Drops the keycap outline, for use inside menus and tooltips. */
    plain?: boolean;
    className?: string;
}
export declare function ShortcutHint({ keys, platform, plain, className, }: ShortcutHintProps): React.ReactElement;

// ---- Skeleton (packages/ui/src/primitives/Skeleton.tsx)
export interface SkeletonProps {
    variant?: "text" | "block" | "circle";
    width?: number | string;
    height?: number | string;
    /** Renders a paragraph of this many text bars. */
    lines?: number;
    className?: string;
}
export declare function Skeleton({ variant, width, height, lines, className, }: SkeletonProps): React.ReactElement;

// ---- StateArt (packages/ui/src/primitives/StateArt.tsx)
export interface StateArtProps {
    /** The glyph in the corner badge, which says what kind of state this is. */
    icon?: IconName;
    /** Error tints the backdrop and badge; everything else is the accent. */
    tone?: "accent" | "error";
    /** The cursor in the doorway blinks while something is under way. */
    busy?: boolean;
}
/**
 * The small picture above an empty, starting or error message: the portico of
 * the Portikus mark with a prompt in its doorway, so every such state shares
 * one look. Decorative; the heading beside it says what it means.
 */
export declare function StateArt({ icon, tone, busy, }: StateArtProps): React.ReactElement;

// ---- StateBadge (packages/ui/src/primitives/StateBadge.tsx)
export type WorkspaceState = "provisioning" | "starting" | "running" | "stopping" | "stopped" | "error";
export type DesiredState = "running" | "stopped" | "restarting";
export type StateTone = WorkspaceState;
/**
 * A difference between the desired state and the actual state is a transition, and
 * a transition is never shown as an error however long it takes (DESIGN.md section 6).
 */
export declare function resolveWorkspaceState(state: WorkspaceState, desiredState?: DesiredState): {
    tone: StateTone;
    label: string;
    moving: boolean;
};
export interface StateBadgeProps {
    state: WorkspaceState;
    desiredState?: DesiredState;
    /** Drops the soft fill, for status bars. */
    plain?: boolean;
    /** Announce changes politely. */
    live?: boolean;
    /** False leaves out `role="status"`, so a long table is not many live regions. */
    statusRole?: boolean;
    label?: string;
    /**
     * Shows the spinner whatever the state, for a pending operation such as a
     * rebuild, whose label says what is moving.
     */
    moving?: boolean;
    className?: string;
}
export declare function StateBadge({ state, desiredState, plain, live, statusRole, label, moving, className, }: StateBadgeProps): React.ReactElement;

// ---- TextField (packages/ui/src/primitives/TextField.tsx)
export { HINT_CLASS } from "./FieldMessages.js";
export declare const FIELD_CLASS = "pk-field grid gap-1.5";
export declare const LABEL_CLASS = "pk-label text-[14px] font-medium leading-[20px] text-ink";
export declare const CONTROL_CLASS = "pk-focus-ring box-border h-[var(--pk-control)] rounded-sm border border-line-strong bg-surface-raised px-[var(--pk-pad)] text-[length:var(--pk-font)] text-ink hover:border-ink-muted w-full";
export interface TextFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "id"> {
    id: string;
    /** Forwarded to the input, for focusing or selecting it. */
    ref?: React.Ref<HTMLInputElement>;
    label: React.ReactNode;
    hint?: React.ReactNode;
    error?: React.ReactNode;
    /**
     * A problem the field can still recover from, such as a name already in
     * use. Shown in the warning colour; the field is not marked invalid, it
     * just points at the warning line.
     */
    warning?: React.ReactNode;
    /** Use for folder names, URLs, ports and typed confirmations. */
    mono?: boolean;
    /** A Toggletip, shown beside the label and never inside it. */
    help?: React.ReactNode;
    /**
     * What the number is counted in, such as "minutes". Shown after the box
     * and read as part of the field's description.
     */
    unit?: string;
}
type TextInputProps = Omit<TextFieldProps, "label" | "help" | "unit"> & {
    /** Set when a unit element with the id `${id}-unit` sits beside the input. */
    hasUnit?: boolean;
};
export type UnitInputProps = Omit<TextInputProps, "hasUnit" | "className"> & {
    unit: string;
};
/**
 * A narrow number box with its unit after it. The unit is part of the box's
 * description, so a screen reader hears "10, minutes". `hint`, `error` and
 * `warning` only link the box to messages the caller renders with
 * `FieldMessages` and the same `id`; the caller's own `aria-describedby` ids
 * come after them, for text elsewhere in its layout. Size the box with
 * `[&_input]:w-*` on a parent.
 */
export declare function UnitInput({ unit, id, ...rest }: UnitInputProps): React.ReactElement;
/** The label row: the label, then a help button beside it when there is one. */
export declare function FieldLabel({ help, children, }: {
    help?: React.ReactNode;
    children: React.ReactElement;
}): React.ReactElement;
export declare function TextField({ id, label, hint, error, warning, mono, help, unit, className, ...rest }: TextFieldProps): React.ReactElement;

// ---- Tooltip (packages/ui/src/primitives/Tooltip.tsx)
/**
 * The next focus, if it lands on a Tooltip trigger now, does not open its
 * tooltip. A menu calls this as it returns focus to its trigger, so the
 * name does not pop up over the neighbouring control.
 */
export declare function skipTooltipOnReturnedFocus(): void;
export interface TooltipProps {
    /** The one element the tooltip belongs to. */
    children: React.ReactElement;
    content: React.ReactNode;
    /** Controls whether the tooltip is open; omit to let hover and focus decide. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /**
     * For a trigger whose name already says the same words: the tooltip is
     * for sighted users and adds no description, so a screen reader reads
     * the words once.
     */
    decorative?: boolean;
}
/** A brief label that opens on hover and on keyboard focus (SPEC.md section 25.8). */
export declare function Tooltip({ children, content, open, onOpenChange, decorative, }: TooltipProps): React.ReactElement;

// ---- confirm-dialog (packages/ui/src/overlays/confirm-dialog.tsx)
export declare const ConfirmDialogRoot: React.FC<RadixAlertDialog.AlertDialogProps>;
export declare const ConfirmDialogTrigger: React.ForwardRefExoticComponent<RadixAlertDialog.AlertDialogTriggerProps & React.RefAttributes<HTMLButtonElement>>;
export interface ConfirmDialogProps {
    id?: string;
    title: string;
    description?: React.ReactNode;
    /** Controls shown under the description, kept out of the accessible description. */
    children?: React.ReactNode;
    lost?: React.ReactNode[];
    survives?: React.ReactNode[];
    confirmLabel: string;
    cancelLabel?: string;
    /** Exact text the person must type before the danger button enables. */
    confirmText?: string;
    onConfirm?: () => void;
    onCancel?: () => void;
    pending?: boolean;
    /** Keeps the confirm button off but focusable; say why in `disabledReason`. */
    disabled?: boolean;
    /** Why confirm is off, announced and tied to the button while `disabled`. */
    disabledReason?: React.ReactNode;
    /** Keeps Cancel and Escape from closing, while Cancel stays focusable; say why in `cancelDisabledReason`. */
    cancelDisabled?: boolean;
    /** Why Cancel is off, announced and tied to the button while `cancelDisabled`. */
    cancelDisabledReason?: React.ReactNode;
    inline?: boolean;
    /** Test hook: set as `data-testid` on the dialog surface. */
    testId?: string;
    /** Preview only: start with this text already typed. */
    typedValue?: string;
    /** False for a reversible action: primary button, info icon, neutral colours. */
    destructive?: boolean;
    /** Where focus goes on close; null falls back to the usual return. */
    returnFocusTo?: () => HTMLElement | null;
}
/** The destructive confirmation. Render it inside a ConfirmDialogRoot. */
export declare function ConfirmDialog({ id, title, description, children, lost, survives, confirmLabel, cancelLabel, confirmText, onConfirm, onCancel, pending, disabled, disabledReason, cancelDisabled, cancelDisabledReason, inline, testId, typedValue, destructive, returnFocusTo, }: ConfirmDialogProps): React.ReactElement;

// ---- dialog (packages/ui/src/overlays/dialog.tsx)
export declare const DialogRoot: React.FC<RadixDialog.DialogProps>;
export declare const DialogTrigger: React.ForwardRefExoticComponent<RadixDialog.DialogTriggerProps & React.RefAttributes<HTMLButtonElement>>;
export interface DialogProps {
    id?: string;
    title: React.ReactNode;
    description?: React.ReactNode;
    children?: React.ReactNode;
    footer?: React.ReactNode;
    size?: "md" | "lg";
    /** Extra classes on the dialog frame. */
    className?: string;
    onClose?: () => void;
    role?: "dialog" | "alertdialog";
    /** Test hook: set as `data-testid` on the dialog surface. */
    testId?: string;
    /** Where focus goes on close; null falls back to the usual return. */
    returnFocusTo?: () => HTMLElement | null;
}
/**
 * The ref of a modal's content, Dialog's or ConfirmDialog's. Stable, so React
 * runs it once on mount and its cleanup once on unmount.
 */
export declare function modalContentRef(content: HTMLElement | null): (() => void) | undefined;
/**
 * Puts focus back where it was when a dialog opened. Most dialogs open from
 * state or a menu item, so Radix has no trigger to return to and focus would
 * fall to the page body.
 */
export declare function useReturnFocus(returnFocusTo?: () => HTMLElement | null): {
    onOpenAutoFocus: () => void;
    onCloseAutoFocus: (event: Event) => void;
};
/**
 * The styled modal. Render it inside a DialogRoot; Radix owns the focus trap,
 * Escape and the return of focus to the trigger; useReturnFocus covers
 * dialogs opened without one.
 */
export declare function Dialog({ id, title, description, children, footer, size, className, onClose, role, testId, returnFocusTo, }: DialogProps): React.ReactElement;

// ---- hide-late-content (packages/ui/src/overlays/hide-late-content.tsx)
/**
 * Keeps a modal's page hidden from screen readers as it changes. Radix hides
 * the page once, when the modal opens, and leaves the ancestors of every
 * `aria-live` region exposed so announcements are still heard; anything that
 * mounts beside those regions later would be exposed behind the modal
 * (SPEC.md §25.8). On such a change this hides the page again, keeping the
 * live regions. Layers opened after the modal, such as a popover or an alert
 * dialog over it, portal to new children of the body and are left alone.
 * Only what is inside `root` is hidden; the default is the whole body.
 * Returns the cleanup, for use from a React ref callback.
 */
export declare function hideLateContent(content: HTMLElement, root?: HTMLElement): () => void;
/**
 * Hides everything inside `root` but `content` from screen readers now and as
 * the page changes, keeping live regions heard (ADR 0047). For a modal that
 * is not a Radix dialog, such as a phone drawer inside the shell, whose
 * toasts and dialogs outside `root` stay reachable. Returns the undo.
 */
export declare function hideOutside(content: HTMLElement, root?: HTMLElement): () => void;

// ---- menu (packages/ui/src/overlays/menu.tsx)
export declare const MenuRoot: React.FC<RadixDropdownMenu.DropdownMenuProps>;
export declare const MenuTrigger: React.ForwardRefExoticComponent<RadixDropdownMenu.DropdownMenuTriggerProps & React.RefAttributes<HTMLButtonElement>>;
export interface ContextMenuProps {
    children?: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
}
/** Root of the right-click variant. Everything inside it renders Radix ContextMenu parts. */
export declare function ContextMenu({ children, onOpenChange, }: ContextMenuProps): React.ReactElement;
export declare const ContextMenuTrigger: React.ForwardRefExoticComponent<RadixContextMenu.ContextMenuTriggerProps & React.RefAttributes<HTMLSpanElement>>;
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
export declare function Menu({ label, children, className, style, onCloseAutoFocus, align, }: MenuProps): React.ReactElement;
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
export declare function MenuItem({ icon, shortcut, danger, disabled, unavailable, onSelect, href, target, rel, download, testId, children, }: MenuItemProps): React.ReactElement;
export interface MenuCheckboxItemProps {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    testId?: string;
    children?: React.ReactNode;
}
/** An on/off item: a menu item the keyboard reaches, not a form checkbox. */
export declare function MenuCheckboxItem({ checked, onCheckedChange, testId, children, }: MenuCheckboxItemProps): React.ReactElement;
export interface MenuRadioGroupProps {
    /** The group's accessible name, usually the text of the `MenuLabel` above it. */
    label: string;
    value: string;
    onValueChange: (value: string) => void;
    children?: React.ReactNode;
}
/** A set of items of which exactly one is chosen, such as a width. */
export declare function MenuRadioGroup({ label, value, onValueChange, children, }: MenuRadioGroupProps): React.ReactElement;
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
export declare function MenuRadioItem({ value, description, unavailable, testId, children, }: MenuRadioItemProps): React.ReactElement;
export interface MenuSubProps {
    /** The text of the item that opens the submenu; it also names the submenu. */
    label: string;
    disabled?: boolean;
    testId?: string;
    children?: React.ReactNode;
}
/** An item that opens a nested menu, such as a list of places to move to. */
export declare function MenuSub({ label, disabled, testId, children, }: MenuSubProps): React.ReactElement;
export declare function MenuSeparator(): React.ReactElement;
export interface MenuLabelProps {
    children?: React.ReactNode;
}
export declare function MenuLabel({ children }: MenuLabelProps): React.ReactElement;

// ---- pane-handle (packages/ui/src/overlays/pane-handle.tsx)
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
export declare function PaneHandle({ orientation, label, state, className, style, onReset, }: PaneHandleProps): React.ReactElement;

// ---- tabs (packages/ui/src/overlays/tabs.tsx)
export interface TabItem {
    id: string;
    kind: "terminal" | "claude" | "codex" | "file" | "diff" | "preview" | "panel";
    label: string;
    /** Hover text, when the label is a shortened form of something longer. */
    title?: string;
    ended?: boolean;
    /** Unsaved changes: the dot takes the close button's place. */
    dirty?: boolean;
    /** What a coding agent in the tab is doing; a finish the student has seen is omitted. */
    agentState?: "working" | "needs-input" | "finished";
    /** The agent stopped while the student was elsewhere; the label turns bold. */
    unread?: boolean;
    /** Test hook: set as `data-testid` on the trigger, plus `-close` on the close control. */
    testId?: string;
}
export interface TabsProps {
    tabs: TabItem[];
    activeId: string;
    label?: string;
    onSelect?: (id: string) => void;
    onClose?: (id: string) => void;
    onReorder?: (from: number, to: number) => void;
    /** The launcher (IconButton + Menu). Defaults to a "New tab" IconButton. */
    actions?: React.ReactNode;
    className?: string;
}
/**
 * DOM ids for a tab and the panel it controls. Radix lets these override its
 * generated ids, so a panel rendered elsewhere can name itself by its tab.
 * Encoded because ids and aria-labelledby cannot hold whitespace.
 */
export declare function tabDomId(id: string): string;
export declare function tabPanelDomId(id: string): string;
export type AgentState = NonNullable<TabItem["agentState"]>;
/**
 * The words for a coding agent's state, such as "needs input, unread". Tabs and
 * the project list both use them, so the two never drift apart. A working agent
 * has nothing unread.
 */
export declare function agentStateWords(state: AgentState, unread?: boolean): string;
/**
 * The glyph for what a coding agent is doing. Each state has its own shape,
 * so colour is never the only signal. Decorative: the caller names the state.
 */
export declare function AgentStateMark({ state, unread, testId, }: {
    state: AgentState;
    unread?: boolean | undefined;
    testId?: string | undefined;
}): React.ReactElement;
export declare const TabsRoot: React.ForwardRefExoticComponent<RadixTabs.TabsProps & React.RefAttributes<HTMLDivElement>>;
export declare const TabsList: React.ForwardRefExoticComponent<RadixTabs.TabsListProps & React.RefAttributes<HTMLDivElement>>;
export declare const TabsTrigger: React.ForwardRefExoticComponent<RadixTabs.TabsTriggerProps & React.RefAttributes<HTMLButtonElement>>;
export declare const TabsContent: React.ForwardRefExoticComponent<RadixTabs.TabsContentProps & React.RefAttributes<HTMLDivElement>>;
/** The work-area tab strip: Radix Tabs with dnd-kit reordering. */
export declare function Tabs({ tabs, activeId, label, onSelect, onClose, onReorder, actions, className, }: TabsProps): React.ReactElement;

// ---- toast (packages/ui/src/overlays/toast.tsx)
export type ToastTone = "neutral" | "success" | "warning" | "danger";
/** How long a toast stays, in milliseconds (SPEC.md section 8.5). */
export declare const TOAST_DURATION_MS: {
    neutral: number;
    success: number;
    warning: number;
    danger: number;
};
/** The toast as plain text, for the notification history. */
export interface ToastRecord {
    tone: ToastTone;
    title: string;
    body: string;
}
/**
 * The visible text of a React node: strings and numbers, and the children of
 * elements, joined. A component that makes its own text contributes none.
 */
export declare function nodeText(node: React.ReactNode): string;
export interface ToastProps {
    tone?: ToastTone;
    title: React.ReactNode;
    children?: React.ReactNode;
    actions?: React.ReactNode;
    onDismiss?: () => void;
    /**
     * Stays until the caller dismisses it, for progress that outlasts the usual
     * duration. An explicit `false` times out even when the toast has actions.
     */
    persistent?: boolean;
    /** Kept out of the notification history: for notices that are not worth saving, or that the server records itself. */
    unrecorded?: boolean;
    className?: string;
}
/** One message. Render it inside a ToastProvider, or let useToast do it for you. */
export declare function Toast({ tone, title, children, actions, onDismiss, persistent, className, ref, }: ToastProps & {
    ref?: React.Ref<HTMLLIElement>;
}): React.ReactElement;
interface ToastApi {
    /** Shows a toast; it dismisses itself or the person does, or the returned function removes it. */
    show: (toast: ToastProps) => () => void;
}
export interface ToastProviderProps {
    children?: React.ReactNode;
    /** Called once for every toast shown, with its text; used to record notifications. */
    onShow?: (toast: ToastRecord) => void;
}
/** Wraps the app once: the Radix provider, the queue, and the bottom-right viewport. */
export declare function ToastProvider({ children, onShow, }: ToastProviderProps): React.ReactElement;
/** Shows toasts from anywhere under a ToastProvider. */
export declare function useToast(): ToastApi;

// ---- toggletip (packages/ui/src/overlays/toggletip.tsx)
export interface ToggletipProps {
    /** What the tip is about. The button is named "About {label}". */
    label: string;
    /** One to three plain sentences. No links or controls. */
    children: React.ReactNode;
}
export declare function Toggletip({ label, children }: ToggletipProps): React.ReactElement;

declare global {
  interface Window {
    Portikus: typeof import("./index");
  }
}
