import { useEffect, useRef } from "react";
import { StandalonePage } from "./StandalonePage.js";

/** Where a launch session lands after unlinking its own course sign-in. */
export function Unlinked() {
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => heading.current?.focus(), []);
	return (
		<StandalonePage title="Unlinked" testId="page-unlinked">
			<h1 id="page-title" className="pk-text-display" tabIndex={-1} ref={heading}>
				Unlinked
			</h1>
			<p className="pk-text-body">
				Open Portikus again from your course to continue with your course account.
			</p>
		</StandalonePage>
	);
}
