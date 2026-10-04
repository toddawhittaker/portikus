import type { AdminEgressView } from "@portikus/contracts";
import { AdminGroup } from "../AdminSection.js";
import { EntriesPart } from "./EntriesPart.js";
import type { EntryDraft } from "./EntryDialog.js";
import { PortsPart } from "./PortsPart.js";
import { PresetsPart } from "./PresetsPart.js";

/** The settings only allow-list mode uses: presets, the administrator's own list, and ports. */
export function AllowListGroup({
	view,
	onEdit,
}: {
	view: AdminEgressView;
	onEdit: (draft: EntryDraft) => void;
}) {
	return (
		<AdminGroup
			id="egress-allow-list-title"
			title="Allow-list"
			testId="egress-allow-list"
			description={
				view.mode === "open"
					? "Open mode is on, so these are not used. You can prepare them before you switch."
					: "Workspaces reach only what these allow, on the ports below."
			}
		>
			<PresetsPart view={view} />
			<EntriesPart view={view} onEdit={onEdit} />
			<PortsPart view={view} />
		</AdminGroup>
	);
}
