import type { Project, Workspace } from "@portikus/contracts";
import {
	Icon,
	Menu,
	MenuItem,
	MenuLabel,
	MenuRoot,
	MenuSeparator,
	MenuTrigger,
	NameMark,
} from "@portikus/ui";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { clearLocalLayouts } from "../layout/local.js";
import { SettingsDialog } from "../settings/SettingsDialog.js";
import type { MeUser } from "../useMe.js";

function initials(displayName: string): string {
	const parts = displayName.trim().split(/\s+/).slice(0, 2);
	return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

/**
 * The top bar: the mark, the project in view, and the account menu.
 * The workspace dialog lives on the status bar (SPEC.md §6).
 */
export function AppHeader({
	workspaceId,
	user,
	project,
}: {
	/** Absent on the administration page, which belongs to no workspace. */
	workspaceId?: string;
	user: MeUser;
	/** Callers still pass the workspace. The status bar owns its dialog. */
	workspace: Workspace | null;
	project: Project | undefined;
}) {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const signOutForm = useRef<HTMLFormElement>(null);

	return (
		<header className="pk-appbar" data-testid="app-header">
			<NameMark size={18} href={workspaceId ? `/workspaces/${workspaceId}` : "/"} />
			<span className="pk-appbar-divider" aria-hidden="true" />
			{project ? (
				<span className="pk-appbar-context">
					<strong>{project.name}</strong>
					<span className="pk-mono-small">~/projects/{project.slug}</span>
				</span>
			) : (
				<span className="pk-appbar-context">
					{workspaceId ? "Your workspace" : "Administration"}
				</span>
			)}
			<span className="pk-appbar-spacer" />

			{workspaceId ? null : (
				<Link to="/" className="pk-wsbutton" data-testid="back-to-workspace">
					Back to your workspace
				</Link>
			)}

			<MenuRoot>
				<MenuTrigger asChild>
					<button type="button" className="pk-account" data-testid="me">
						<span className="pk-initials">{initials(user.displayName)}</span>
						{/* The gap is only visual. This space is part of the button text. */}{" "}
						<span>{user.displayName}</span>
						<Icon name="chevron-down" size="sm" />
					</button>
				</MenuTrigger>
				<Menu label="Account">
					<MenuLabel>{user.email ?? user.displayName}</MenuLabel>
					<MenuSeparator />
					{user.role === "administrator" && workspaceId ? (
						<>
							{/* A new tab, so this tab keeps its sockets open and the
							    disconnect grace timer never starts (SPEC.md §6.4). */}
							<MenuItem
								icon="external"
								href="/admin"
								target="_blank"
								rel="noopener"
								testId="admin-link"
							>
								Administration
							</MenuItem>
							<MenuSeparator />
						</>
					) : null}
					<MenuItem onSelect={() => setSettingsOpen(true)}>
						<span data-testid="editor-settings">Settings</span>
					</MenuItem>
					<MenuSeparator />
					<MenuItem
						icon="sign-out"
						onSelect={() => {
							// The next person at this browser starts clean (SPEC.md §24.2).
							clearLocalLayouts();
							signOutForm.current?.requestSubmit();
						}}
					>
						<span data-testid="signout">Sign out</span>
					</MenuItem>
				</Menu>
			</MenuRoot>
			{/* A real form post, so the session cookie is cleared by the server. */}
			<form ref={signOutForm} method="post" action="/auth/logout" className="hidden" />

			{settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
		</header>
	);
}
