import { Icon } from "@portikus/ui";
import type { ChatToolItem } from "./chatStore.js";
import { isPlanCall, toolLine } from "./toolView.js";

const DECIDED: Record<NonNullable<ChatToolItem["decision"]>, string> = {
	allowed: "Allowed:",
	allowedAlways: "Allowed for this chat:",
	denied: "Denied:",
};

/**
 * How the student answered the call's permission card, as a quiet line under
 * its row: "Denied: rm -rf build", or for a plan "Plan approved" (SPEC.md
 * §10.8). The host replays it on attach, so a reload or another browser shows
 * the same. The deny reason stays in the card's answer only.
 */
export function DecisionLine({ tool }: { tool: ChatToolItem }) {
	const { decision } = tool;
	if (decision === undefined) return null;
	const allowed = decision !== "denied";
	const line = toolLine(tool.name, tool.input, tool.title);
	return (
		<li className="pk-chat-step">
			<p
				className="pk-chat-decision"
				data-testid="chat-decision"
				data-decision={decision}
			>
				<Icon
					name={allowed ? "check" : "x"}
					size="sm"
					className="pk-chat-decision-icon"
				/>
				{isPlanCall(tool.name) ? (
					<span>{allowed ? "Plan approved" : "Kept planning"}</span>
				) : (
					<span className="pk-chat-decision-text">
						{DECIDED[decision]}{" "}
						<span
							className={line.literal ? "pk-mono-body" : undefined}
							title={line.path ?? line.target}
						>
							{line.target || tool.name}
						</span>
					</span>
				)}
			</p>
		</li>
	);
}
