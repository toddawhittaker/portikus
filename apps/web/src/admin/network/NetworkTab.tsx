import { Button, Skeleton } from "@portikus/ui";
import { useRef, useState } from "react";
import { AdminGroup, AdminSection } from "../AdminSection.js";
import { AllowListGroup } from "./AllowListGroup.js";
import { BlockedCard } from "./BlockedCard.js";
import { BlockedSitesCard } from "./BlockedSitesCard.js";
import { EntryDialog, type EntryDraft } from "./EntryDialog.js";
import { ModeCard } from "./ModeCard.js";
import { ProxyHostsGroup } from "./ProxyHostsGroup.js";
import { egressErrorText, useEgress } from "./queries.js";
import { TestHostCard } from "./TestHostCard.js";

const INTRO = {
	id: "admin-network",
	helpAnchor: "admin-network",
	text: "Which internet sites workspaces can reach. Open mode allows every public site except the ones you block. Allow-list mode allows only the presets, hosts and ranges you list.",
};

/** The admin Network tab: the workspace egress allow-list (SPEC.md section 20.1). */
export function NetworkTab() {
	const egress = useEgress();
	const [draft, setDraft] = useState<EntryDraft | null>(null);
	// Where focus goes after an Allow saves: the row or button it came from is gone.
	const [returnTo, setReturnTo] = useState<string | null>(null);
	const saved = useRef(false);

	if (egress.isError && !egress.data) {
		return (
			<AdminSection title="Network">
				<AdminGroup
					id="egress-error-title"
					title="Network policy did not load"
					testId="egress-error"
				>
					<div className="grid justify-items-start gap-3">
						<p className="m-0 text-status-error" role="alert">
							{egressErrorText(egress.error)}
						</p>
						<Button onClick={() => void egress.refetch()}>Try again</Button>
					</div>
				</AdminGroup>
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
			<div className="@container grid gap-4" data-testid="egress-tab">
				<ModeCard view={view} />
				<div className="grid gap-4 @5xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
					<div className="grid content-start gap-4">
						{/* The list that matters in the current mode comes first. */}
						{view.mode === "open" ? <BlockedSitesCard view={view} /> : null}
						<AllowListGroup view={view} onEdit={edit} />
						{view.mode === "allow-list" ? <BlockedSitesCard view={view} /> : null}
					</div>
					{/*
					 * Kept in view beside the long lists, so a test is always one field away.
					 * Capped to what <main> shows (its height less the content's padding
					 * above and below) and scrolled on its own, so a long Refused names
					 * list cannot push its bottom out of reach. A tab stop of its own lets
					 * the keyboard scroll it (WCAG 2.1.1).
					 */}
					<section
						className="pk-focus-ring grid content-start gap-4 self-start rounded-md @5xl:sticky @5xl:top-0 @5xl:max-h-[calc(100cqh-3rem)] @5xl:overflow-y-auto @5xl:overscroll-contain"
						aria-label="Test a host and refused names"
						// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolled region the keyboard must reach
						tabIndex={0}
						data-testid="egress-side"
					>
						<TestHostCard view={view} onAllow={allowFrom("egress-test-title")} />
						<BlockedCard view={view} onAllow={allowFrom("egress-blocked-title")} />
					</section>
				</div>
			</div>
			<ProxyHostsGroup />
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
