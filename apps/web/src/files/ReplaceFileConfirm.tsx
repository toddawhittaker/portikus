/**
 * Ask before a rename or move replaces an existing file (SPEC.md §11.2).
 * The agent replaces only a file, never a directory, so a folder in the
 * way still fails with the usual "already taken" message.
 */
import { ConfirmDialog, ConfirmDialogRoot } from "@portikus/ui";
import { useCallback, useState } from "react";
import { isFileExists } from "./errors.js";
import { baseName, displayName } from "./paths.js";

type Move = (args: { from: string; to: string; replace?: boolean }) => Promise<unknown>;

interface Pending {
	to: string;
	resolve: (replace: boolean) => void;
}

/**
 * A move that asks before replacing. Resolves true when the move happened,
 * false when the student kept the existing file.
 */
export function useMoveAskingToReplace(move: Move) {
	const [pending, setPending] = useState<Pending | null>(null);

	const moveAsking = useCallback(
		async (from: string, to: string, isDir: boolean): Promise<boolean> => {
			try {
				await move({ from, to });
				return true;
			} catch (error) {
				if (isDir || !isFileExists(error)) throw error;
			}
			const replace = await new Promise<boolean>((resolve) => {
				setPending({ to, resolve });
			});
			setPending(null);
			if (!replace) return false;
			await move({ from, to, replace: true });
			return true;
		},
		[move],
	);

	const confirm = pending ? (
		<ConfirmDialogRoot open onOpenChange={(open) => !open && pending.resolve(false)}>
			<ConfirmDialog
				testId="dialog-replace-file"
				title={`Replace ${displayName(baseName(pending.to))}?`}
				description={`A file named ${displayName(pending.to)} is already there. Replacing it overwrites its contents. This cannot be undone.`}
				confirmLabel="Replace"
				onCancel={() => pending.resolve(false)}
				onConfirm={() => pending.resolve(true)}
			/>
		</ConfirmDialogRoot>
	) : null;

	return { moveAsking, confirm };
}
