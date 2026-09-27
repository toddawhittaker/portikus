import { Button, Skeleton } from "@portikus/ui";
import { useState } from "react";
import { AdminSection } from "../AdminSection.js";
import { BlockedCard } from "./BlockedCard.js";
import { EntriesCard } from "./EntriesCard.js";
import { EntryDialog, type EntryDraft } from "./EntryDialog.js";
import { ModeCard } from "./ModeCard.js";
import { PortsCard } from "./PortsCard.js";
import { PresetsCard } from "./PresetsCard.js";
import { egressErrorText, useEgress } from "./queries.js";
import { TestHostCard } from "./TestHostCard.js";

/** The admin Network tab: the workspace egress allow-list (issue #284, SPEC.md section 20.1). */
export function NetworkTab() {
	const egress = useEgress();
	const [draft, setDraft] = useState<EntryDraft | null>(null);

	if (egress.isError && !egress.data) {
		return (
			<AdminSection title="Network">
				<div className="pk-card grid justify-items-start gap-3 p-6">
					<p className="m-0 text-status-error" role="alert">
						{egressErrorText(egress.error)}
					</p>
					<Button onClick={() => void egress.refetch()}>Try again</Button>
				</div>
			</AdminSection>
		);
	}

	const view = egress.data;
	if (!view) {
		return (
			<AdminSection title="Network">
				<div className="grid gap-6" aria-busy="true" data-testid="egress-loading">
					<Skeleton variant="block" height={120} />
					<Skeleton variant="block" height={240} />
				</div>
			</AdminSection>
		);
	}

	const allow = (host: string) => setDraft({ kind: "host", value: host, label: "" });

	return (
		<AdminSection title="Network">
			<div className="grid gap-6" data-testid="egress-tab">
				<ModeCard view={view} />
				{view.mode === "open" ? (
					<p className="m-0 text-[13px] text-ink-muted" data-testid="egress-open-note">
						Open mode is on, so the presets and list below are not used yet. You can
						prepare them before you switch.
					</p>
				) : null}
				<div className="grid items-start gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
					<div className="grid gap-6">
						<PresetsCard view={view} />
						<EntriesCard view={view} onEdit={setDraft} />
						<PortsCard view={view} />
					</div>
					<div className="grid gap-6">
						<TestHostCard view={view} onAllow={allow} />
						<BlockedCard view={view} onAllow={allow} />
					</div>
				</div>
			</div>
			{draft ? (
				<EntryDialog
					draft={draft}
					version={view.version}
					onClose={() => setDraft(null)}
				/>
			) : null}
		</AdminSection>
	);
}
