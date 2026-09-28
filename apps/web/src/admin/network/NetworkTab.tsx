import { Button, Skeleton } from "@portikus/ui";
import { useRef, useState } from "react";
import { AdminSection } from "../AdminSection.js";
import { BlockedCard } from "./BlockedCard.js";
import { BlockedSitesCard } from "./BlockedSitesCard.js";
import { EntriesCard } from "./EntriesCard.js";
import { EntryDialog, type EntryDraft } from "./EntryDialog.js";
import { ModeCard } from "./ModeCard.js";
import { PortsCard } from "./PortsCard.js";
import { PresetsCard } from "./PresetsCard.js";
import { egressErrorText, useEgress } from "./queries.js";
import { TestHostCard } from "./TestHostCard.js";

const INTRO = {
	id: "admin-network",
	helpAnchor: "admin-network",
	text: "Which internet sites workspaces can reach. Open mode allows every public site except the ones you block. Allow-list mode allows only the presets, hosts and ranges you list.",
};

/** The admin Network tab: the workspace egress allow-list (issue #284, SPEC.md section 20.1). */
export function NetworkTab() {
	const egress = useEgress();
	const [draft, setDraft] = useState<EntryDraft | null>(null);
	// Where focus goes after an Allow saves: the row or button it came from is gone.
	const [returnTo, setReturnTo] = useState<string | null>(null);
	const saved = useRef(false);

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

	const allowFrom = (headingId: string) => (host: string) => {
		setReturnTo(headingId);
		saved.current = false;
		setDraft({ kind: "host", value: host, label: "" });
	};
	const edit = (next: EntryDraft) => {
		setReturnTo(null);
		saved.current = false;
		setDraft(next);
	};

	return (
		<AdminSection title="Network" intro={INTRO}>
			<div className="grid gap-6" data-testid="egress-tab">
				<ModeCard view={view} />
				{view.mode === "open" ? (
					<p className="m-0 text-[13px] text-ink-muted" data-testid="egress-open-note">
						Open mode is on, so only the blocked sites are used. The presets, hosts and
						ports are for allow-list mode; you can prepare them before you switch.
					</p>
				) : null}
				<div className="grid items-start gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
					<div className="grid gap-6">
						{/* The list that matters in the current mode comes first. */}
						{view.mode === "open" ? <BlockedSitesCard view={view} /> : null}
						<PresetsCard view={view} />
						<EntriesCard view={view} onEdit={edit} />
						<PortsCard view={view} />
						{view.mode === "allow-list" ? <BlockedSitesCard view={view} /> : null}
					</div>
					<div className="grid gap-6">
						<TestHostCard view={view} onAllow={allowFrom("egress-test-title")} />
						<BlockedCard view={view} onAllow={allowFrom("egress-blocked-title")} />
					</div>
				</div>
			</div>
			{draft ? (
				<EntryDialog
					draft={draft}
					version={view.version}
					onClose={() => setDraft(null)}
					onSaved={() => {
						saved.current = true;
						setDraft(null);
					}}
					returnFocusTo={() => {
						if (!saved.current || !returnTo) return null;
						saved.current = false;
						return document.getElementById(returnTo);
					}}
				/>
			) : null}
		</AdminSection>
	);
}
