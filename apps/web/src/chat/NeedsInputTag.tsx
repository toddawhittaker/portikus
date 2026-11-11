import { AgentStateMark, Badge } from "@portikus/ui";

/** The tag in a docked card's header that says Claude is waiting on the student. */
export function NeedsInputTag() {
	return (
		<p className="m-0" data-testid="chat-needs-input">
			<Badge tone="warning">
				<AgentStateMark state="needs-input" />
				Needs your input
			</Badge>
		</p>
	);
}
