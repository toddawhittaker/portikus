import { useEffect, useRef, useState } from "react";
import { requestGrant } from "./grants.js";

/**
 * Opens one preview as a page of its own (SPEC.md §14.6). A preview frame
 * whose browser refused the embedded cookie links here, because only the
 * Portikus origin can ask for a grant (BROWSER-HANDLING.md §7.2, §9.1).
 */
export function OpenPreviewPage({
	workspaceId,
	port,
}: {
	workspaceId: string;
	port: number | undefined;
}) {
	const [failed, setFailed] = useState(port === undefined);
	// One grant per visit, even when a development render runs effects twice.
	const asked = useRef(false);
	useEffect(() => {
		if (port === undefined || asked.current) return;
		asked.current = true;
		requestGrant(workspaceId, port, "top-level").then(
			(grant) => window.location.replace(grant.bootstrapUrl),
			() => setFailed(true),
		);
	}, [workspaceId, port]);
	return (
		<main className="pk-root" aria-busy={!failed}>
			{failed ? (
				<p role="alert">
					This preview could not be opened. Make sure the workspace is running, then
					open the preview again from Portikus.
				</p>
			) : (
				<p>Opening the preview…</p>
			)}
		</main>
	);
}
