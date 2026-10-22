import { ConfirmDialog, ConfirmDialogRoot } from "@portikus/ui";
import { useBlocker } from "@tanstack/react-router";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { plural } from "../../text.js";

type Report = (section: string, count: number) => void;

const UnsavedContext = createContext<Report>(() => {});

/** "1 unsaved change", "3 unsaved changes". */
export function unsavedText(count: number): string {
	return plural(count, "unsaved change");
}

/**
 * What the leave dialog says: each section with unsaved changes and how
 * many, never their values, which may be secret.
 */
export function leaveText(counts: ReadonlyMap<string, number>): string {
	const parts = [...counts].map(
		([section, count]) => `${section} has ${unsavedText(count)}.`,
	);
	const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
	return `${parts.join(" ")} ${total === 1 ? "It is" : "They are"} lost if you leave.`;
}

/**
 * Each section reports how many unsaved changes it holds. While any has one,
 * leaving the Settings tab asks first, and so does closing or reloading the
 * browser tab (the browser's own prompt).
 */
export function UnsavedChanges({ children }: { children: ReactNode }) {
	const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map());
	const report = useCallback<Report>((section, count) => {
		setCounts((now) => {
			if ((now.get(section) ?? 0) === count) return now;
			const next = new Map(now);
			if (count === 0) next.delete(section);
			else next.set(section, count);
			return next;
		});
	}, []);
	return (
		<UnsavedContext.Provider value={report}>
			{children}
			<LeaveGuard counts={counts} />
		</UnsavedContext.Provider>
	);
}

/** Tell the page this section's unsaved count; it is cleared when the section goes. */
export function useReportUnsaved(section: string, count: number) {
	const report = useContext(UnsavedContext);
	useEffect(() => report(section, count), [report, section, count]);
	useEffect(() => () => report(section, 0), [report, section]);
}

function LeaveGuard({ counts }: { counts: ReadonlyMap<string, number> }) {
	const unsaved = counts.size > 0;
	// The section index's #links change only the hash, so they never ask.
	const shouldBlockFn = useCallback(
		({
			current,
			next,
		}: {
			current: { pathname: string };
			next: { pathname: string };
		}) => current.pathname !== next.pathname,
		[],
	);
	const blocker = useBlocker({
		shouldBlockFn,
		enableBeforeUnload: true,
		disabled: !unsaved,
		withResolver: true,
	});
	// The text stays while the dialog closes, though the counts may not.
	const shown = useRef("");
	if (blocker.status === "blocked") shown.current = leaveText(counts);
	return (
		<ConfirmDialogRoot
			open={blocker.status === "blocked"}
			onOpenChange={(open) => {
				if (!open) blocker.reset?.();
			}}
		>
			<ConfirmDialog
				id="settings-leave"
				testId="settings-leave-dialog"
				title="Leave without saving?"
				description={shown.current}
				confirmLabel="Leave without saving"
				cancelLabel="Stay on Settings"
				destructive={false}
				onConfirm={() => blocker.proceed?.()}
				onCancel={() => blocker.reset?.()}
			/>
		</ConfirmDialogRoot>
	);
}
