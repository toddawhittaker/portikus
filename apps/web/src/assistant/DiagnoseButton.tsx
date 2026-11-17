/**
 * A Diagnose button (SPEC.md section 20.5): it opens the assistant on one
 * item, in a conversation that can only read. It shows for administrators
 * on a page that has the assistant, while the assistant is enabled, and
 * nowhere else.
 */
import type { AssistantContext as AssistantTarget } from "@portikus/contracts";
import { Button, Icon } from "@portikus/ui";
import { useMe } from "../useMe.js";
import { useAssistant, useOptionalAssistant } from "./AssistantContext.js";
import { useAssistantStatus } from "./useAssistant.js";
import "./assistant.css";

export function DiagnoseButton({
	context,
	name,
	label = "Diagnose",
	onOpen,
}: {
	context: AssistantTarget;
	/** What the button's name says it does, for a screen reader; it starts with the visible label. */
	name: string;
	/** The visible words; Diagnose unless the button helps with setup. */
	label?: string;
	/** After the panel opens, such as closing a dialog the button sat in. */
	onOpen?: () => void;
}) {
	// A page without the assistant has nothing to open.
	if (!useOptionalAssistant()) return null;
	return <Available context={context} name={name} label={label} onOpen={onOpen} />;
}

function Available({
	context,
	name,
	label,
	onOpen,
}: {
	context: AssistantTarget;
	name: string;
	label: string;
	onOpen: (() => void) | undefined;
}) {
	const assistant = useAssistant();
	const me = useMe();
	const isAdmin = me.status === "authenticated" && me.user.role === "administrator";
	const status = useAssistantStatus(isAdmin);
	if (!isAdmin || status.data?.enabled !== true) return null;
	return (
		<Button
			variant="secondary"
			size="sm"
			className="pk-diagnose"
			aria-label={name}
			data-testid={
				context.kind === "setup"
					? `diagnose-setup-${context.id}`
					: `diagnose-${context.kind}`
			}
			onClick={() => {
				assistant.open({ context });
				onOpen?.();
			}}
		>
			<Icon name="agent" size="sm" />
			{label}
		</Button>
	);
}
