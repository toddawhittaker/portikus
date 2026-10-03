import {
	DesiredState,
	type PendingOperation,
	WorkspaceState,
} from "@portikus/contracts";
import {
	StateBadge,
	type DesiredState as UiDesiredState,
	type WorkspaceState as UiWorkspaceState,
} from "@portikus/ui";
import { PENDING_LABEL } from "../shell/StatusBar.js";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// The ui package cannot import contracts, so its copy of the states is checked here.
const uiStatesMatchContracts: Same<UiWorkspaceState, WorkspaceState> &
	Same<UiDesiredState, DesiredState> = true;
void uiStatesMatchContracts;

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
	const known = WorkspaceState.safeParse(state);
	if (!known.success) return <span className="pk-tag">{state}</span>;
	return (
		<StateBadge
			state={known.data}
			statusRole={statusRole}
			desiredState={DesiredState.safeParse(desiredState).data}
		/>
	);
}
