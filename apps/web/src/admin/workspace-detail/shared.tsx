import { Toggletip } from "@portikus/ui";
import type * as React from "react";

/** Every section heading in the panel: small, bold and quiet. */
export const SECTION_HEADING = "pk-group-label";

/** Help text for the panel's toggletips, checked against the code. */
export const PANEL_HELP = {
	reprovision:
		"Creates the workspace again after it failed. Its home folder and files are kept.",
	rebuild:
		"Recreates the workspace from the current image. Anything installed with sudo apt is lost. Projects, home and, unless you untick it, Docker data stay.",
	lastInput:
		"The student's last key press in the page, file save or preview page load; a start counts too. Idle stop counts from here. Your own visits never count.",
	preview:
		"Reachable and forwarded ports open in a preview; forwarded means Portikus relays a port that listens only inside the workspace. Unknown ports are relayed when a preview first opens them. System marks the workspace's own services.",
} as const;

/** A definition term with its toggletip beside it. */
export function TipTerm({
	children,
	label,
	tip,
}: {
	children: string;
	label: string;
	tip: string;
}) {
	return (
		<dt className="flex items-start gap-0.5">
			<span className="pt-0.5">{children}</span>
			<Toggletip label={label}>{tip}</Toggletip>
		</dt>
	);
}

/** A button with its toggletip, kept together inside an actions row. */
export function WithTip({
	children,
	label,
	tip,
}: {
	children: React.ReactNode;
	label: string;
	/** Null shows the button alone, for the state the tip does not describe. */
	tip: string | null;
}) {
	return (
		<span className="inline-flex items-center gap-0.5">
			{children}
			{/* Always this wrapper, so the button keeps its focus when the tip goes. */}
			{tip === null ? null : <Toggletip label={label}>{tip}</Toggletip>}
		</span>
	);
}

/** Why a button for an operation this build does not have is off. */
export const NOT_AVAILABLE_TEXT =
	"Rebuild and Reset Docker are not available in this release.";
