import type { PendingOperation } from "@portikus/contracts";
import { type DesiredState, StateBadge, type WorkspaceState } from "@portikus/ui";
import { PENDING_LABEL } from "../shell/StatusBar.js";

export const KNOWN_STATES: readonly string[] = [
	"provisioning",
	"starting",
	"running",
	"stopping",
	"stopped",
	"error",
];
const KNOWN_DESIRED: readonly string[] = ["running", "stopped", "restarting"];

/**
 * A state the badge knows is drawn as one; anything newer shows its raw name.
 * A pending rebuild or reset wins, drawn like the student's status.
 */
export function WorkspaceStateBadge({
	state,
	desiredState,
	pendingOperation,
	statusRole,
}: {
	state: string;
	desiredState: string;
	pendingOperation?: PendingOperation | null;
	/** In a table cell or inside a status wrapper, so it is not its own live region. */
	statusRole?: boolean;
}) {
	if (pendingOperation) {
		return (
			<StateBadge
				state="starting"
				label={PENDING_LABEL[pendingOperation]}
				statusRole={statusRole}
			/>
		);
	}
	if (!KNOWN_STATES.includes(state)) return <span className="pk-tag">{state}</span>;
	return (
		<StateBadge
			state={state as WorkspaceState}
			statusRole={statusRole}
			desiredState={
				KNOWN_DESIRED.includes(desiredState)
					? (desiredState as DesiredState)
					: undefined
			}
		/>
	);
}
