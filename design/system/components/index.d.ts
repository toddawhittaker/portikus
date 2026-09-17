// Portikus packages/ui: public component types. Each export maps 1:1 to an export of packages/ui.
import type * as React from 'react';

export type IconName = 'terminal' | 'agent' | 'file' | 'folder' | 'folder-open' | 'preview' | 'plus' | 'x' | 'more'
  | 'chevron-right' | 'chevron-down' | 'chevron-up' | 'chevron-up-down' | 'external' | 'alert' | 'check' | 'info'
  | 'search' | 'play' | 'stop' | 'restart' | 'lock' | 'grip' | 'storage' | 'trash' | 'sign-out';
export type Key = 'Mod' | 'Alt' | 'Shift' | 'Ctrl' | 'Enter' | string;
export type WorkspaceState = 'provisioning' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
export type DesiredState = 'running' | 'stopped' | 'restarting';

export interface NameMarkProps { size?: number; href?: string; markOnly?: boolean; className?: string }
export declare function NameMark(props: NameMarkProps): React.ReactElement;

export interface IconProps { name: IconName; size?: 'sm' | 'md' | 'lg'; label?: string; className?: string }
export declare function Icon(props: IconProps): React.ReactElement;

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  iconStart?: IconName;
  iconEnd?: IconName;
}
export declare function Button(props: ButtonProps): React.ReactElement;

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconName;
  /** Required. Becomes aria-label and the tooltip text. */
  label: string;
  shortcut?: Key[];
  variant?: 'quiet' | 'secondary';
  size?: 'sm' | 'md';
  /** Preview only: render the tooltip open. */
  tooltipOpen?: boolean;
}
export declare function IconButton(props: IconButtonProps): React.ReactElement;

/** Styled content of Radix DropdownMenu / ContextMenu. */
export interface MenuProps { label?: string; children?: React.ReactNode; className?: string; style?: React.CSSProperties }
export declare function Menu(props: MenuProps): React.ReactElement;
export interface MenuItemProps { icon?: IconName; shortcut?: Key[]; danger?: boolean; disabled?: boolean; highlighted?: boolean; onSelect?: () => void; children?: React.ReactNode }
export declare function MenuItem(props: MenuItemProps): React.ReactElement;
export declare function MenuSeparator(): React.ReactElement;
export declare function MenuLabel(props: { children?: React.ReactNode }): React.ReactElement;

/** Radix Dialog. */
export interface DialogProps {
  id?: string; title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode;
  footer?: React.ReactNode; size?: 'md' | 'lg'; onClose?: () => void; hideClose?: boolean;
  statusIcon?: IconName; role?: 'dialog' | 'alertdialog';
  /** Preview only: position inside the nearest positioned ancestor instead of the viewport. */
  inline?: boolean;
}
export declare function Dialog(props: DialogProps): React.ReactElement;

/** Radix AlertDialog for destructive actions. */
export interface ConfirmDialogProps {
  id?: string; title: string; description?: React.ReactNode;
  lost?: React.ReactNode[]; survives?: React.ReactNode[];
  confirmLabel: string; cancelLabel?: string;
  /** Exact text the person must type before the danger button enables. */
  confirmText?: string;
  onConfirm?: () => void; onCancel?: () => void; pending?: boolean;
  inline?: boolean; typedValue?: string;
}
export declare function ConfirmDialog(props: ConfirmDialogProps): React.ReactElement;

export interface TabItem {
  id: string; kind: 'terminal' | 'claude' | 'codex' | 'file' | 'preview' | 'panel'; label: string;
  title?: string; dirty?: boolean; ended?: boolean; closable?: boolean;
}
/** Radix Tabs list + dnd-kit sortable. */
export interface TabsProps {
  tabs: TabItem[]; activeId: string; label?: string;
  onSelect?: (id: string) => void; onClose?: (id: string) => void; onReorder?: (from: number, to: number) => void;
  /** The launcher (IconButton + Menu). Defaults to a "New tab" IconButton. */
  actions?: React.ReactNode; launcherOpen?: boolean;
  draggingId?: string; dropBeforeId?: string; className?: string;
}
export declare function Tabs(props: TabsProps): React.ReactElement;

/** Radix Toast. */
export interface ToastProps { tone?: 'neutral' | 'success' | 'warning' | 'danger'; title: React.ReactNode; children?: React.ReactNode; actions?: React.ReactNode; onDismiss?: () => void; className?: string }
export declare function Toast(props: ToastProps): React.ReactElement;

export interface StateBadgeProps { state: WorkspaceState; desiredState?: DesiredState; plain?: boolean; live?: boolean; label?: string; className?: string }
export declare function StateBadge(props: StateBadgeProps): React.ReactElement;
export declare function resolveWorkspaceState(state: WorkspaceState, desiredState?: DesiredState): {
  tone: 'provisioning' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error'; label: string; moving: boolean;
};

export interface TableColumn<Row> {
  key: string; header: string; width?: number | string; align?: 'left' | 'right';
  mono?: boolean; muted?: boolean; sortable?: boolean; sort?: 'asc' | 'desc';
  render?: (row: Row) => React.ReactNode;
}
export interface TableProps<Row> { label: string; columns: TableColumn<Row>[]; rows: Row[]; rowKey?: keyof Row & string; selectedKey?: string; style?: React.CSSProperties }
export declare function Table<Row extends Record<string, unknown>>(props: TableProps<Row>): React.ReactElement;

export interface TextFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'id'> { id: string; label: React.ReactNode; hint?: React.ReactNode; error?: React.ReactNode; mono?: boolean }
export declare function TextField(props: TextFieldProps): React.ReactElement;

/** Radix Select. */
export interface SelectProps { id: string; label: React.ReactNode; options?: { value: string; label: string }[]; value?: string; placeholder?: string; hint?: React.ReactNode; open?: boolean; onValueChange?: (v: string) => void }
export declare function Select(props: SelectProps): React.ReactElement;

/** Radix Checkbox. */
export interface CheckboxProps { label: React.ReactNode; description?: React.ReactNode; checked?: boolean; disabled?: boolean; onChange?: React.ChangeEventHandler<HTMLInputElement> }
export declare function Checkbox(props: CheckboxProps): React.ReactElement;

export interface SkeletonProps { variant?: 'text' | 'block' | 'circle'; width?: number | string; height?: number | string; lines?: number; className?: string }
export declare function Skeleton(props: SkeletonProps): React.ReactElement;

export interface EmptyStateProps { icon?: IconName; title: React.ReactNode; children?: React.ReactNode; actions?: React.ReactNode; className?: string }
export declare function EmptyState(props: EmptyStateProps): React.ReactElement;

export interface ShortcutHintProps { keys: Key[]; platform?: 'mac' | 'other'; plain?: boolean; className?: string }
export declare function ShortcutHint(props: ShortcutHintProps): React.ReactElement;

/** react-resizable-panels PanelResizeHandle. */
export interface PaneHandleProps { orientation?: 'vertical' | 'horizontal'; label?: string; value?: number; min?: number; max?: number; controls?: string; state?: 'inactive' | 'hover' | 'drag'; className?: string; style?: React.CSSProperties }
export declare function PaneHandle(props: PaneHandleProps): React.ReactElement;

declare global {
  interface Window {
    Portikus: {
      NameMark: typeof NameMark; Icon: typeof Icon; Button: typeof Button; IconButton: typeof IconButton;
      Menu: typeof Menu; MenuItem: typeof MenuItem; MenuSeparator: typeof MenuSeparator; MenuLabel: typeof MenuLabel;
      Dialog: typeof Dialog; ConfirmDialog: typeof ConfirmDialog; Tabs: typeof Tabs; Toast: typeof Toast;
      StateBadge: typeof StateBadge; resolveWorkspaceState: typeof resolveWorkspaceState; Table: typeof Table;
      TextField: typeof TextField; Select: typeof Select; Checkbox: typeof Checkbox; Skeleton: typeof Skeleton;
      EmptyState: typeof EmptyState; ShortcutHint: typeof ShortcutHint; PaneHandle: typeof PaneHandle;
    };
  }
}
