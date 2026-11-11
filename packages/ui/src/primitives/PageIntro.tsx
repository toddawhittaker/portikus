import * as React from "react";
import { Icon } from "./Icon.js";

export interface PageIntroProps {
	/** Names the remembered open or closed state, such as "admin-users". */
	id: string;
	/** The line that stays visible, such as "About Users". */
	summary: string;
	/** One or two plain sentences on what the page is for. */
	children: React.ReactNode;
	/** A Help page anchor, such as "/admin/help#admin-users", opened in a new tab. */
	helpHref?: string;
	/**
	 * One short line on what the page is for, always shown above the
	 * disclosure. With a lead the disclosure starts closed, as the lead
	 * already says what the page is for.
	 */
	lead?: string;
}

const storageKey = (id: string) => `pk-intro:${id}`;

function readOpen(id: string, startOpen: boolean): boolean {
	try {
		const saved = window.localStorage.getItem(storageKey(id));
		return saved === null ? startOpen : saved === "open";
	} catch {
		// Storage can be blocked; the intro then starts as it would the first time.
		return startOpen;
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
 * A short explanation under a page heading, remembered open or closed per
 * page in this browser. Without a lead it is open until the person closes
 * it; with one, closed until they open it.
 */
export function PageIntro({
	id,
	summary,
	children,
	helpHref,
	lead,
}: PageIntroProps): React.ReactElement {
	const [open, setOpen] = React.useState(() => readOpen(id, lead === undefined));
	const details = (
		<details
			className="pk-intro"
			open={open}
			data-testid={lead === undefined ? `intro-${id}` : undefined}
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
	if (lead === undefined) return details;
	return (
		<div className="pk-intro-wrap" data-testid={`intro-${id}`}>
			<p className="pk-intro-lead">{lead}</p>
			{details}
		</div>
	);
}
