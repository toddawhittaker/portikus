/**
 * The "Show the full command" disclosure that Monitor and Running share
 * (SPEC.md §18.2, §18.3). The button sits in a row's actions;
 * the text shows below the row, wrapped, in monospace. Only the student's
 * own processes carry a command line (SPEC.md §24.11).
 */
import { IconButton } from "@portikus/ui";

export function FullCommandButton({
	subject,
	expanded,
	detailId,
	testId,
	onToggle,
}: {
	/** What the command belongs to, as in "PID 42" or "port 5173". */
	subject: string;
	expanded: boolean;
	detailId: string;
	testId: string;
	onToggle: () => void;
}) {
	return (
		<IconButton
			icon={expanded ? "chevron-down" : "chevron-right"}
			size="sm"
			label={`Show the full command for ${subject}`}
			aria-expanded={expanded}
			aria-controls={expanded ? detailId : undefined}
			data-testid={testId}
			onClick={onToggle}
		/>
	);
}

export function FullCommandText({
	id,
	commandLine,
}: {
	id: string;
	commandLine: string;
}) {
	return (
		<div className="pk-full-command" id={id} data-testid={id}>
			{commandLine}
		</div>
	);
}
