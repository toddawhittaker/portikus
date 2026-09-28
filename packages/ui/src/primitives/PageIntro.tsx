import * as React from "react";
import { Icon } from "./Icon.js";

export interface PageIntroProps {
	/** Names the remembered open or closed state, such as "admin-users". */
	id: string;
	/** The line that stays visible, such as "About Users". */
	summary: string;
	/** One or two plain sentences on what the page is for. */
	children: React.ReactNode;
	/** A Help page anchor, such as "/help#admin-users", opened in a new tab. */
	helpHref?: string;
}

const storageKey = (id: string) => `pk-intro:${id}`;

function readOpen(id: string): boolean {
	try {
		return window.localStorage.getItem(storageKey(id)) !== "closed";
	} catch {
		// Storage can be blocked; the intro then starts open every time.
		return true;
	}
}

function saveOpen(id: string, open: boolean): void {
	try {
		window.localStorage.setItem(storageKey(id), open ? "open" : "closed");
	} catch {
		// Not remembered this time; nothing else depends on it.
	}
}

/**
 * A short explanation under a page heading. Open until the person closes
 * it, and remembered per page in this browser.
 */
export function PageIntro({
	id,
	summary,
	children,
	helpHref,
}: PageIntroProps): React.ReactElement {
	const [open, setOpen] = React.useState(() => readOpen(id));
	return (
		<details
			className="pk-intro"
			open={open}
			data-testid={`intro-${id}`}
			onToggle={(event) => {
				const next = event.currentTarget.open;
				if (next === open) return;
				setOpen(next);
				saveOpen(id, next);
			}}
		>
			<summary className="pk-intro-summary pk-focus-ring">
				<Icon name="info" size="sm" />
				<span>{summary}</span>
				<Icon name="chevron-down" size="sm" className="pk-intro-chevron" />
			</summary>
			<div className="pk-intro-body">
				<p className="m-0">{children}</p>
				{helpHref ? (
					<a className="pk-link" href={helpHref} target="_blank" rel="noopener">
						More in Help<span className="sr-only"> (opens in a new tab)</span>
					</a>
				) : null}
			</div>
		</details>
	);
}
