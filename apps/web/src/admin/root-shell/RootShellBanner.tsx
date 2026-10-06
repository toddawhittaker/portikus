import { Notice } from "../Notice.js";

/**
 * The fixed strip above the panes that says what these shells are
 * (ADR 0051 decision 6, and its consequences on restarts and reloads).
 */
export function RootShellBanner() {
	return (
		<Notice tone="warning" testId="root-shell-banner">
			<strong>These are root shells on this server, outside every workspace.</strong>{" "}
			Nothing you type or see is recorded; opening and closing a shell is audited.
			Reloading this page, leaving the admin pages or restarting Portikus ends every
			root shell, so run upgrades inside tmux.
		</Notice>
	);
}
