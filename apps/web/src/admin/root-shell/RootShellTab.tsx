import type { RootShellStatus } from "@portikus/contracts";
import { EmptyState, Skeleton } from "@portikus/ui";
import type { UseQueryResult } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { errorText } from "../../api/request.js";

// xterm.js loads only when an administrator opens the Root shell tab.
const RootShellArea = lazy(() =>
	import("./RootShellArea.js").then((module) => ({ default: module.RootShellArea })),
);

function Loading() {
	return (
		<div className="px-4 py-6" aria-busy="true">
			<Skeleton lines={2} />
		</div>
	);
}

/** The Root shell tab on a server that offers none: the tab is hidden, but the address still works. */
function RootShellOff() {
	return (
		<section className="flex flex-col gap-4 px-4 py-6" aria-labelledby="root-shell-off">
			<h2
				className="pk-text-heading m-0"
				id="root-shell-off"
				tabIndex={-1}
				data-admin-heading
			>
				Root shell
			</h2>
			<div className="pk-card" data-testid="root-shell-off">
				<EmptyState icon="info" title="Root shells are turned off on this server">
					The operator turned them off with portikus_root_shell: false in portikus.yaml.
					Use SSH to reach the server.
				</EmptyState>
			</div>
		</section>
	);
}

/**
 * The Root shell tab's content. Once opened, the shells stay mounted while
 * another admin tab shows, so a look at Logs does not end them; leaving the
 * admin pages does (ADR 0051). Rendered after every other tab, so a hidden
 * heading here is never the one `focusAdminHeading` finds first.
 */
export function RootShellTab({
	shown,
	status,
}: {
	shown: boolean;
	status: UseQueryResult<RootShellStatus>;
}) {
	const enabled = status.data?.enabled === true;
	const [kept, setKept] = useState(false);
	if (shown && enabled && !kept) setKept(true);

	return (
		<>
			{shown && status.isPending ? <Loading /> : null}
			{shown && status.data?.enabled === false ? <RootShellOff /> : null}
			{shown && status.isError ? (
				<p className="px-4 py-6 text-status-error" role="alert">
					{errorText(status.error)}
				</p>
			) : null}
			{kept ? (
				<Suspense fallback={shown ? <Loading /> : null}>
					<RootShellArea visible={shown} />
				</Suspense>
			) : null}
		</>
	);
}
