import type { UpdatePlatformSettingsRequest } from "@portikus/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { errorText } from "../../api/request.js";
import { adminKeys, useUpdatePlatformSettings } from "../queries.js";

/**
 * Saves one section's changed fields. Each section has its own, so one
 * section's save does not show as pending in another. The answer is the
 * whole saved row, so the page shows it at once instead of the old values
 * until the refetch lands.
 */
export function useSaveSettings() {
	const client = useQueryClient();
	const update = useUpdatePlatformSettings();
	return {
		pending: update.isPending,
		send(
			body: UpdatePlatformSettingsRequest,
			draft: {
				sending: () => void;
				saved: () => void;
				fail: (message: string) => void;
			},
			onSaved?: () => void,
		) {
			draft.sending();
			update.mutate(body, {
				onSuccess: (saved) => {
					client.setQueryData(adminKeys.settings, saved);
					draft.saved();
					onSaved?.();
				},
				onError: (failure) => draft.fail(errorText(failure)),
			});
		},
	};
}

/**
 * After a save is refused for a field, focus the first such field once the
 * error is on the page, so a screen reader hears it with the field. A field
 * inside a closed disclosure opens it first, so a refused box is never hidden.
 */
export function useFocusFirstError(
	errors: Record<string, string | undefined>,
	idOf: (key: string) => string,
) {
	const pending = useRef(false);
	useEffect(() => {
		if (!pending.current) return;
		pending.current = false;
		const first = Object.keys(errors)[0];
		const field = first ? document.getElementById(idOf(first)) : null;
		if (!field) return;
		const fold = field.closest("details");
		if (fold && !fold.open) fold.open = true;
		field.focus();
	}, [errors, idOf]);
	return () => {
		pending.current = true;
	};
}
