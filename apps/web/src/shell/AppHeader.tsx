import type { Project, Workspace } from "@portikus/contracts";
import {
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
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
	resolveWorkspaceState,
	StateBadge,
	useToast,
} from "@portikus/ui";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useWorkspaceAction } from "../api/workspace.js";
import type { MeUser } from "../useMe.js";
import { type ThemePreference, useThemePreference } from "./theme.js";

const ROLE_LABEL = { student: "Student", administrator: "Administrator" } as const;

const APPEARANCE: { value: ThemePreference; label: string }[] = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

/** Image fingerprints are 64 characters; a student only ever needs the head of one. */
function shortImage(imageVersion: string | null): string {
	if (!imageVersion) return "—";
	return imageVersion.length > 12 ? `${imageVersion.slice(0, 12)}…` : imageVersion;
}

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
	/** Absent on the administration page, which belongs to no workspace. */
	workspaceId?: string;
	user: MeUser;
	workspace: Workspace | null;
	project: Project | undefined;
}) {
	const [statusOpen, setStatusOpen] = useState(false);
	const [preference, setPreference] = useThemePreference();
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

			{workspaceId ? (
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
						<StateBadge
							state="starting"
							desiredState="running"
							label="Connecting"
							live
						/>
					)}
				</button>
			) : null}

			{workspaceId ? (
				<IconButton
					icon="search"
					label="Search arrives in Epic 7"
					shortcut={["Mod", "Shift", "F"]}
					disabled
				/>
			) : null}

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
					{user.role === "administrator" && workspaceId ? (
						<>
							<MenuSeparator />
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
						</>
					) : null}
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
						<dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1 text-[13px]">
							<dt className="text-ink-muted">State</dt>
							<dd className="m-0" data-testid="workspace-status-state">
								{workspace?.state ?? "connecting"}
							</dd>
							<dt className="text-ink-muted">Desired state</dt>
							<dd className="m-0">{workspace?.desiredState ?? "running"}</dd>
							<dt className="text-ink-muted">Connections</dt>
							<dd className="m-0">{workspace?.activeConnections ?? 0}</dd>
							<dt className="text-ink-muted">Image</dt>
							<dd
								className="m-0 min-w-0 pk-mono-small"
								data-testid="workspace-status-image"
								title={workspace?.imageVersion ?? undefined}
							>
								{shortImage(workspace?.imageVersion ?? null)}
							</dd>
						</dl>
						{workspace?.errorMessage ? (
							<p className="pk-text-body mt-4 text-status-error">
								{workspace.errorMessage}
							</p>
						) : null}
						{workspaceId ? (
							<WorkspaceControls workspaceId={workspaceId} workspace={workspace} />
						) : null}
					</Dialog>
				)}
			</DialogRoot>
		</header>
	);
}

/**
 * Start, stop and restart from the workspace dialog (SPEC.md §6.2). These
 * only ask the API to change the desired state, so they still work when the
 * workspace itself is hung, which is how a student recovers one.
 */
function WorkspaceControls({
	workspaceId,
	workspace,
}: {
	workspaceId: string;
	workspace: Workspace | null;
}) {
	const action = useWorkspaceAction(workspaceId);
	const toast = useToast();
	const [confirming, setConfirming] = useState<"stop" | "restart" | null>(null);

	const resolved = workspace
		? resolveWorkspaceState(workspace.state, workspace.desiredState)
		: null;
	// No workspace yet means the presence socket has not reported one.
	const moving = resolved === null || resolved.moving || action.isPending;
	const stopped = workspace?.state === "stopped" || workspace?.state === "error";

	function run(next: "start" | "stop" | "restart") {
		setConfirming(null);
		action.mutate(next, {
			onError: (error) =>
				toast.show({
					tone: "danger",
					title: "The workspace did not change",
					children: error instanceof Error ? error.message : undefined,
				}),
		});
	}

	return (
		<div className="mt-5 flex flex-wrap items-center gap-2">
			{stopped ? (
				<Button
					variant="primary"
					disabled={moving}
					data-testid="workspace-start"
					onClick={() => run("start")}
				>
					Start workspace
				</Button>
			) : (
				<>
					<Button
						disabled={moving}
						data-testid="workspace-restart"
						onClick={() => setConfirming("restart")}
					>
						Restart workspace
					</Button>
					<Button
						disabled={moving}
						data-testid="workspace-stop"
						onClick={() => setConfirming("stop")}
					>
						Stop workspace
					</Button>
				</>
			)}
			{resolved?.moving ? (
				<span
					className="pk-text-small text-ink-muted"
					data-testid="workspace-transition"
				>
					{resolved.label} your workspace.
				</span>
			) : null}

			<ConfirmDialogRoot
				open={confirming !== null}
				onOpenChange={(open) => !open && setConfirming(null)}
			>
				{confirming ? (
					<ConfirmDialog
						testId={`dialog-workspace-${confirming}`}
						title={
							confirming === "stop" ? "Stop your workspace?" : "Restart your workspace?"
						}
						description="Programs running in the workspace end. Your files are kept."
						lost={["everything running now, including terminals and servers"]}
						survives={["every file in your home directory"]}
						confirmLabel={
							confirming === "stop" ? "Stop workspace" : "Restart workspace"
						}
						pending={action.isPending}
						onCancel={() => setConfirming(null)}
						onConfirm={() => run(confirming)}
					/>
				) : null}
			</ConfirmDialogRoot>
		</div>
	);
}
