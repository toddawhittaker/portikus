/**
 * Who may open the assistant panel and with what. A page mounts the
 * provider once; its Assistant button and any Diagnose button open the
 * same panel through `useAssistant()`.
 */
import type { AssistantContext as AssistantTarget } from "@portikus/contracts";
import {
	createContext,
	type ReactNode,
	type RefObject,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";

export interface AssistantStart {
	context?: AssistantTarget;
	courseId?: string;
}

/** A request to start a conversation, new each time so the same start runs twice. */
export interface PendingStart extends AssistantStart {
	nonce: number;
}

export interface AssistantApi {
	isOpen: boolean;
	/** Show the panel. With a start, also begin a new conversation from it. */
	open: (start?: AssistantStart) => void;
	close: () => void;
	/** The start the panel has yet to act on. */
	pending: PendingStart | null;
	takePending: () => void;
	/** The panel's button, where focus goes back on close. */
	launcher: RefObject<HTMLButtonElement | null>;
}

const AssistantApiContext = createContext<AssistantApi | null>(null);

export function AssistantProvider({ children }: { children: ReactNode }) {
	const [isOpen, setOpen] = useState(false);
	const [pending, setPending] = useState<PendingStart | null>(null);
	const launcher = useRef<HTMLButtonElement | null>(null);
	const nonce = useRef(0);

	const open = useCallback((start?: AssistantStart) => {
		setOpen(true);
		if (start) {
			nonce.current += 1;
			setPending({ ...start, nonce: nonce.current });
		}
	}, []);
	const close = useCallback(() => {
		setOpen(false);
		// After the panel is gone, so the button is the next thing in view.
		requestAnimationFrame(() => launcher.current?.focus());
	}, []);
	const takePending = useCallback(() => setPending(null), []);

	const api = useMemo(
		() => ({ isOpen, open, close, pending, takePending, launcher }),
		[isOpen, open, close, pending, takePending],
	);
	return (
		<AssistantApiContext.Provider value={api}>{children}</AssistantApiContext.Provider>
	);
}

/** The assistant's API when a provider is above, else null: a button shown on pages without one hides itself. */
export function useOptionalAssistant(): AssistantApi | null {
	return useContext(AssistantApiContext);
}

export function useAssistant(): AssistantApi {
	const api = useContext(AssistantApiContext);
	if (!api) throw new Error("useAssistant needs an AssistantProvider");
	return api;
}
