import * as RadixToast from "@radix-ui/react-toast";
import * as React from "react";
import { Icon, IconButton, type IconName } from "../primitives/index.js";

export type ToastTone = "neutral" | "success" | "warning" | "danger";

const TONE_ICON: Record<ToastTone, IconName> = {
	neutral: "info",
	success: "check",
	warning: "alert",
	danger: "alert",
};

/** How long a toast stays, in milliseconds (SPEC.md section 8.5). */
export const TOAST_DURATION_MS = {
	neutral: 5000,
	success: 5000,
	warning: 10_000,
	danger: 10_000,
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
export function nodeText(node: React.ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(nodeText).join("");
	if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
		return nodeText(node.props.children);
	}
	return "";
}

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
export function Toast({
	tone = "neutral",
	title,
	children,
	actions,
	onDismiss,
	persistent,
	className,
	ref,
}: ToastProps & { ref?: React.Ref<HTMLLIElement> }): React.ReactElement {
	const urgent = tone === "warning" || tone === "danger";
	return (
		<RadixToast.Root
			ref={ref}
			type={urgent ? "foreground" : "background"}
			// A toast that asks for an answer stays until answered; Radix pauses the rest on hover or focus.
			duration={
				persistent || (actions && persistent !== false)
					? Number.POSITIVE_INFINITY
					: TOAST_DURATION_MS[tone]
			}
			onOpenChange={(open) => {
				if (!open) onDismiss?.();
			}}
			className={`pk-toast pk-toast--${tone} w-full rounded-md border border-line bg-surface-raised py-3 pr-3 pl-4 shadow-md ${className ?? ""}`}
		>
			{/* The role sits inside the list item, so the viewport's list holds only list items. */}
			<div role={urgent ? "alert" : "status"} className="flex items-start gap-3">
				<Icon name={TONE_ICON[tone]} className="pk-toast-icon" />
				<div className="min-w-0 flex-1">
					<RadixToast.Title className="m-0 font-semibold text-ink">
						{title}
					</RadixToast.Title>
					{children ? (
						<RadixToast.Description className="mt-0.5 mb-0 text-ink-muted">
							{children}
						</RadixToast.Description>
					) : null}
					{actions ? <div className="mt-2 flex gap-2">{actions}</div> : null}
				</div>
				<RadixToast.Close asChild>
					<IconButton icon="x" label="Dismiss" size="sm" className="-mt-0.5 -mr-0.5" />
				</RadixToast.Close>
			</div>
		</RadixToast.Root>
	);
}

interface QueuedToast extends ToastProps {
	key: number;
}

interface ToastApi {
	/** Shows a toast; it dismisses itself or the person does, or the returned function removes it. */
	show: (toast: ToastProps) => () => void;
}

const ToastContext = React.createContext<ToastApi | null>(null);

/** The space left between a lifted stack and the control it steps above, in pixels. */
const LIFT_GAP_PX = 8;

/**
 * The stack's `bottom` while it steps above a focused control it would cover
 * in its corner, or null at home: a toast never covers a focused element
 * (WCAG 2.2 SC 2.4.11). It goes home when focus moves somewhere clear.
 */
function useClearOfFocus(
	viewport: React.RefObject<HTMLOListElement | null>,
	count: number,
): number | null {
	const [lift, setLift] = React.useState<number | null>(null);
	const lifted = React.useRef(false);
	// Where the stack's bottom edge is at home, measured while it is there.
	const homeBottom = React.useRef(0);

	const place = React.useCallback(() => {
		const stack = viewport.current;
		if (!stack) return;
		const box = stack.getBoundingClientRect();
		if (!lifted.current) homeBottom.current = box.bottom;
		const active = document.activeElement;
		if (active && stack.contains(active)) return;
		let next: number | null = null;
		if (active instanceof HTMLElement && active !== document.body && box.height > 0) {
			const target = active.getBoundingClientRect();
			const covered =
				target.left < box.right &&
				box.left < target.right &&
				target.top < homeBottom.current &&
				homeBottom.current - box.height < target.bottom;
			if (covered) next = window.innerHeight - target.top + LIFT_GAP_PX;
		}
		lifted.current = next !== null;
		setLift(next);
	}, [viewport]);

	React.useEffect(() => {
		document.addEventListener("focusin", place);
		window.addEventListener("resize", place);
		return () => {
			document.removeEventListener("focusin", place);
			window.removeEventListener("resize", place);
		};
	}, [place]);

	// A toast that arrives, or goes, changes the stack's height.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the number of toasts changes
	React.useLayoutEffect(place, [place, count]);

	return lift;
}

export interface ToastProviderProps {
	children?: React.ReactNode;
	/** Called once for every toast shown, with its text; used to record notifications. */
	onShow?: (toast: ToastRecord) => void;
}

/** Wraps the app once: the Radix provider, the queue, and the bottom-right viewport. */
export function ToastProvider({
	children,
	onShow,
}: ToastProviderProps): React.ReactElement {
	const [toasts, setToasts] = React.useState<QueuedToast[]>([]);
	const nextKey = React.useRef(0);
	const onShowRef = React.useRef(onShow);
	onShowRef.current = onShow;
	const viewportRef = React.useRef<HTMLOListElement>(null);
	const nodes = React.useRef(new Map<number, HTMLLIElement>());
	const lift = useClearOfFocus(viewportRef, toasts.length);
	const api = React.useMemo<ToastApi>(
		() => ({
			show(toast) {
				if (!toast.unrecorded) {
					onShowRef.current?.({
						tone: toast.tone ?? "neutral",
						title: nodeText(toast.title),
						body: nodeText(toast.children),
					});
				}
				nextKey.current += 1;
				const key = nextKey.current;
				setToasts((current) => [...current, { ...toast, key }]);
				return () => {
					// Radix moves focus to the viewport only on its own close paths, so do the same here.
					if (nodes.current.get(key)?.contains(document.activeElement)) {
						viewportRef.current?.focus();
					}
					setToasts((current) => current.filter((item) => item.key !== key));
				};
			},
		}),
		[],
	);
	return (
		<ToastContext.Provider value={api}>
			<RadixToast.Provider swipeDirection="right">
				{children}
				{toasts.map(({ key, onDismiss, ...toast }) => (
					<Toast
						key={key}
						{...toast}
						ref={(node) => {
							if (node) nodes.current.set(key, node);
							else nodes.current.delete(key);
						}}
						onDismiss={() => {
							setToasts((current) => current.filter((item) => item.key !== key));
							onDismiss?.();
						}}
					/>
				))}
				{/* Radix fills {hotkey} with F8, the only keyboard route to a toast. */}
				<RadixToast.Viewport
					ref={viewportRef}
					style={lift === null ? undefined : { bottom: lift }}
					label="Notifications (press {hotkey} to reach them)"
					className="pk-toast-viewport fixed right-4 bottom-4 z-[var(--z-toast)] m-0 flex w-95 max-w-[calc(100vw-2rem)] list-none flex-col gap-2 p-0 outline-none"
				/>
			</RadixToast.Provider>
		</ToastContext.Provider>
	);
}

/** Shows toasts from anywhere under a ToastProvider. */
export function useToast(): ToastApi {
	const api = React.useContext(ToastContext);
	if (!api) throw new Error("useToast must be used inside a ToastProvider");
	return api;
}
