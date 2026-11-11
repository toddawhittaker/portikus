import { AgentStateMark } from "@portikus/ui";
import "./needs-input-tag.css";

/** The tag in a docked card's header that says Claude is waiting on the student. */
export function NeedsInputTag() {
	return (
		<p className="pk-chat-needs" data-testid="chat-needs-input">
			<AgentStateMark state="needs-input" />
			Needs your input
		</p>
	);
}
