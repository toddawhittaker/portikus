import type { Project, Workspace } from "@portikus/contracts";
import {
	Dialog,
	DialogRoot,
	Icon,
	IconButton,
	Menu,
	MenuItem,
	MenuLabel,
	MenuRoot,
	MenuSeparator,
	MenuTrigger,
	NameMark,
	StateBadge,
} from "@portikus/ui";
import { useRef, useState } from "react";
import type { MeUser } from "../useMe.js";
import { type ThemePreference, useThemePreference } from "./theme.js";

const ROLE_LABEL = { student: "Student", administrator: "Administrator" } as const;

const APPEARANCE: { value: ThemePreference; label: string }[] = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

function initials(displayName: string): string {
	const parts = displayName.trim().split(/\s+/).slice(0, 2);
	return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

/** The top bar: the mark, the project in view, workspace state and the account menu. */
export function AppHeader({
	workspaceId,
	user,
	workspace,
	project,
}: {
	workspaceId: string;
	user: MeUser;
	workspace: Workspace | null;
	project: Project | undefined;
}) {
	const [statusOpen, setStatusOpen] = useState(false);
	const [preference, setPreference] = useThemePreference();
	const signOutForm = useRef<HTMLFormElement>(null);

	return (
		<header className="pk-appbar" data-testid="app-header">
			<NameMark size={18} href={`/workspaces/${workspaceId}`} />
			<span className="pk-appbar-divider" aria-hidden="true" />
			{project ? (
				<span className="pk-appbar-context">
					<strong>{project.name}</strong>
					<span className="pk-mono-small">~/projects/{project.slug}</span>
				</span>
			) : (
				<span className="pk-appbar-context">Your workspace</span>
			)}
			<span className="pk-appbar-spacer" />

			<button
				type="button"
				className="pk-wsbutton"
				aria-haspopup="dialog"
				data-testid="workspace-status"
				onClick={() => setStatusOpen(true)}
			>
				<span>Workspace</span>
				{workspace ? (
					<StateBadge
						state={workspace.state}
						desiredState={workspace.desiredState}
						live
					/>
				) : (
					<StateBadge state="starting" desiredState="running" label="Connecting" live />
				)}
			</button>

			<IconButton
				icon="search"
				label="Search arrives in Epic 7"
				shortcut={["Mod", "Shift", "F"]}
				disabled
			/>

			<MenuRoot>
				<MenuTrigger asChild>
					<button type="button" className="pk-account" data-testid="me">
						<span className="pk-initials" aria-hidden="true">
							{initials(user.displayName)}
						</span>
						<span>{user.displayName}</span>
						<span className="pk-account-role">{ROLE_LABEL[user.role]}</span>
						<Icon name="chevron-down" size="sm" />
					</button>
				</MenuTrigger>
				<Menu label="Account">
					<MenuLabel>{user.email ?? user.displayName}</MenuLabel>
					<MenuSeparator />
					<MenuLabel>Appearance</MenuLabel>
					{APPEARANCE.map((option) => (
						<MenuItem
							key={option.value}
							icon={preference === option.value ? "check" : undefined}
							onSelect={() => setPreference(option.value)}
						>
							<span data-testid={`appearance-${option.value}`}>{option.label}</span>
						</MenuItem>
					))}
					<MenuSeparator />
					<MenuItem
						icon="sign-out"
						onSelect={() => signOutForm.current?.requestSubmit()}
					>
						<span data-testid="signout">Sign out</span>
					</MenuItem>
				</Menu>
			</MenuRoot>
			{/* A real form post, so the session cookie is cleared by the server. */}
			<form ref={signOutForm} method="post" action="/auth/logout" className="hidden" />

			<DialogRoot open={statusOpen} onOpenChange={setStatusOpen}>
				{statusOpen && (
					<Dialog
						testId="dialog-workspace-status"
						title="Your workspace"
						description="What Portikus knows about the machine behind this window."
						onClose={() => setStatusOpen(false)}
					>
						<dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-[13px]">
							<dt className="text-ink-muted">State</dt>
							<dd className="m-0" data-testid="workspace-status-state">
								{workspace?.state ?? "connecting"}
							</dd>
							<dt className="text-ink-muted">Desired state</dt>
							<dd className="m-0">{workspace?.desiredState ?? "running"}</dd>
							<dt className="text-ink-muted">Connections</dt>
							<dd className="m-0">{workspace?.activeConnections ?? 0}</dd>
							<dt className="text-ink-muted">Image</dt>
							<dd className="m-0 pk-mono-small">{workspace?.imageVersion ?? "—"}</dd>
						</dl>
						{workspace?.errorMessage ? (
							<p className="pk-text-body mt-4 text-status-error">
								{workspace.errorMessage}
							</p>
						) : null}
					</Dialog>
				)}
			</DialogRoot>
		</header>
	);
}
