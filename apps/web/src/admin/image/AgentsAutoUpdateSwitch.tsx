import { useToast } from "@portikus/ui";
import { errorText } from "../../api/request.js";
import { usePlatformSettings, useUpdatePlatformSettings } from "../queries.js";

const NOTE = "image-agents-auto-note";

/**
 * The site switch for the nightly coding-agents update (SPEC.md sections
 * 22.4 and 22.6). It saves on change, like the other one-value switches.
 */
export function AgentsAutoUpdateSwitch() {
	const settings = usePlatformSettings();
	const save = useUpdatePlatformSettings();
	const toast = useToast();
	if (settings.isPending) return null;
	if (!settings.data) {
		return (
			<p className="pk-muted m-0 text-[13px]" data-testid="image-agents-auto-unread">
				The nightly update setting could not be read.
			</p>
		);
	}
	const saved = settings.data.codingAgentsAutoUpdate;
	// Shows the new position while the save runs.
	const on = save.isPending ? (save.variables?.codingAgentsAutoUpdate ?? saved) : saved;

	function toggle(next: boolean) {
		if (save.isPending) return;
		save.mutate(
			{ codingAgentsAutoUpdate: next },
			{
				onSuccess: () =>
					toast.show({
						tone: "success",
						title: next ? "Nightly update turned on" : "Nightly update turned off",
					}),
			},
		);
	}

	return (
		<div className="grid gap-1">
			<label className="pk-switch text-[13px]">
				<input
					type="checkbox"
					role="switch"
					aria-checked={on}
					data-testid="image-agents-auto-switch"
					checked={on}
					aria-disabled={save.isPending || undefined}
					aria-describedby={NOTE}
					onChange={(event) => toggle(event.target.checked)}
				/>
				<span>Update automatically each night</span>
			</label>
			<p id={NOTE} className="pk-muted m-0 text-[13px]">
				When the daily check finds a newer version, the host runs this update once
				between 08:00 and 09:00 UTC, unless another image job is running.
			</p>
			{save.isError ? (
				<p className="m-0 text-[13px] text-status-error" role="alert">
					{errorText(save.error)}
				</p>
			) : null}
		</div>
	);
}
