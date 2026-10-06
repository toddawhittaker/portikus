import { Notice } from "../Notice.js";

/**
 * The fixed strip beside the heading that says what these shells are
 * (ADR 0051 decision 6). One line, so the panes keep the height; the
 * audit detail is in Help.
 */
export function RootShellBanner() {
	return (
		<Notice tone="warning" testId="root-shell-banner">
			<strong>Root on this server.</strong> Reloading, leaving these admin pages or
			restarting Portikus ends every shell, so run upgrades in tmux.{" "}
			<a
				className="pk-link"
				href="/admin/help#admin-shell"
				target="_blank"
				rel="noopener"
			>
				Help<span className="sr-only"> (opens in a new tab)</span>
			</a>
		</Notice>
	);
}
