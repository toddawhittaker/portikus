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

export interface ToastProps {
	tone?: ToastTone;
	title: React.ReactNode;
	children?: React.ReactNode;
	actions?: React.ReactNode;
	onDismiss?: () => void;
	className?: string;
}

/** One message. Render it inside a ToastProvider, or let useToast do it for you. */
export function Toast({
	tone = "neutral",
	title,
	children,
	actions,
	onDismiss,
	className,
}: ToastProps): React.ReactElement {
	// Warnings and errors stay until dismissed; the rest go after 5 seconds.
	const sticky = tone === "warning" || tone === "danger";
	return (
		<RadixToast.Root
			type={sticky ? "foreground" : "background"}
			role={sticky ? "alert" : "status"}
			// Radix takes a number of milliseconds, so "stays until dismissed" is a day.
			duration={sticky ? 24 * 60 * 60 * 1000 : 5000}
			onOpenChange={(open) => {
				if (!open) onDismiss?.();
			}}
			className={`pk-toast pk-toast--${tone} flex w-95 items-start gap-3 rounded-md border border-line bg-surface-raised py-3 pr-3 pl-4 shadow-md ${className ?? ""}`}
		>
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
		</RadixToast.Root>
	);
}

interface QueuedToast extends ToastProps {
	key: number;
}

interface ToastApi {
	/** Shows a toast and returns nothing; it dismisses itself or the person does. */
	show: (toast: ToastProps) => void;
}

const ToastContext = React.createContext<ToastApi | null>(null);

export interface ToastProviderProps {
	children?: React.ReactNode;
}

/** Wraps the app once: the Radix provider, the queue, and the bottom-right viewport. */
export function ToastProvider({ children }: ToastProviderProps): React.ReactElement {
	const [toasts, setToasts] = React.useState<QueuedToast[]>([]);
	const nextKey = React.useRef(0);
	const api = React.useMemo<ToastApi>(
		() => ({
			show(toast) {
				nextKey.current += 1;
				setToasts((current) => [...current, { ...toast, key: nextKey.current }]);
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
						onDismiss={() => {
							setToasts((current) => current.filter((item) => item.key !== key));
							onDismiss?.();
						}}
					/>
				))}
				<RadixToast.Viewport className="pk-toast-viewport fixed right-4 bottom-4 z-50 m-0 flex w-95 list-none flex-col gap-2 p-0 outline-none" />
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
