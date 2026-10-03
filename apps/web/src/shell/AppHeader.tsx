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
	useToast,
} from "@portikus/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useRef, useState } from "react";
import { errorText } from "../api/request.js";
import { useOpenWorkspace } from "../api/workspace.js";
import { useCourses } from "../course/queries.js";
import { clearLocalLayouts } from "../layout/local.js";
import { NotificationsDialog } from "../notifications/NotificationsDialog.js";
import { useNotifications } from "../notifications/queries.js";
import { initials } from "../settings/ProfilePane.js";
import { useProfile } from "../settings/profileQueries.js";
import { SettingsDialog } from "../settings/SettingsDialog.js";
import type { MeUser } from "../useMe.js";

/** The badge text: the count, "9+" above nine, nothing at zero. */
export function badgeText(unread: number): string | null {
	if (unread <= 0) return null;
	return unread > 9 ? "9+" : String(unread);
}

/** Help opens the administrator help from an admin page and the workspace help elsewhere (SPEC.md section 8.6). */
export function helpHref(pathname: string): string {
	return pathname === "/admin" || pathname.startsWith("/admin/")
		? "/admin/help"
		: "/help";
}

/** What the bar is showing: the project in view, or the workspace or page. */
function AppbarContext({
	project,
	workspaceId,
	context,
}: {
	project: Project | undefined;
	workspaceId: string | undefined;
	context: string;
}) {
	if (project) {
		return (
			<span className="pk-appbar-context">
				<strong>{project.name}</strong>
				<span className="pk-mono-small">~/projects/{project.slug}</span>
			</span>
		);
	}
	return (
		<span className="pk-appbar-context">
			{workspaceId ? "Your workspace" : context}
		</span>
	);
}

/** The profile picture, or the initials when there is none. */
function AccountPicture({
	picture,
	displayName,
}: {
	picture: string | null;
	displayName: string;
}) {
	if (picture) {
		return (
			<img
				className="pk-initials object-cover"
				src={picture}
				alt=""
				data-testid="account-picture"
			/>
		);
	}
	return <span className="pk-initials">{initials(displayName)}</span>;
}

/**
 * The top bar: the mark, the project in view, and the account menu.
 * The workspace dialog lives on the status bar (SPEC.md §6).
 */
export function AppHeader({
	workspaceId,
	user,
	project,
	context = "Administration",
	nav,
}: {
	/** Absent on the administration page, which belongs to no workspace. */
	workspaceId?: string;
	user: MeUser;
	/** Callers still pass the workspace. The status bar owns its dialog. */
	workspace: Workspace | null;
	project: Project | undefined;
	/** What the bar names when there is no workspace, such as "Course". */
	context?: string;
	/** Page navigation shown after the context, such as the admin tabs. */
	nav?: ReactNode;
}) {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [notificationsOpen, setNotificationsOpen] = useState(false);
	const unread = useNotifications().data?.unreadCount ?? 0;
	const badge = badgeText(unread);
	const unreadLabel = `${unread} unread notification${unread === 1 ? "" : "s"}`;
	const signOutForm = useRef<HTMLFormElement>(null);
	const accountButton = useRef<HTMLButtonElement>(null);
	const badgeButton = useRef<HTMLButtonElement>(null);
	const picture = useProfile().data?.picture ?? null;
	const hasCourse = (useCourses().data?.length ?? 0) > 0;
	const open = useOpenWorkspace();
	const navigate = useNavigate();
	const toast = useToast();

	/** An administrator's way into their own workspace, made on first open (SPEC.md §6.1). */
	function openMyWorkspace() {
		if (open.isPending) return;
		open.mutate(undefined, {
			onSuccess: (workspace) =>
				void navigate({ to: "/workspaces/$id", params: { id: workspace.id } }),
			onError: (error) =>
				toast.show({
					tone: "danger",
					title: "Your workspace did not open",
					children: errorText(error, "Something went wrong opening it. Try again."),
				}),
		});
	}

	return (
		<header className="pk-appbar @container" data-testid="app-header">
			<NameMark size={18} href={workspaceId ? `/workspaces/${workspaceId}` : "/"} />
			{/* On a narrow bar the context gives way first: below 80rem beside page tabs, whose label names the page, else below 40rem. */}
			<span
				className={nav ? "contents @max-7xl:hidden" : "contents @max-[40rem]:hidden"}
			>
				<span className="pk-appbar-divider" aria-hidden="true" />
				<AppbarContext project={project} workspaceId={workspaceId} context={context} />
			</span>
			{nav}
			<span className="pk-appbar-spacer" />

			{hasCourse && workspaceId ? (
				// A new tab, like Administration, so the workspace keeps its sockets.
				<a
					href="/course"
					target="_blank"
					rel="noopener"
					className="pk-wsbutton"
					data-testid="course-link"
				>
					Course
					<Icon name="external" size="sm" />
					<span className="sr-only"> (opens in a new tab)</span>
				</a>
			) : null}

			{/* "/" sends an administrator to /admin, so they get a menu item instead. */}
			{workspaceId || user.role === "administrator" ? null : (
				<Link
					to="/"
					className="pk-wsbutton pk-wsbutton-text"
					data-testid="back-to-workspace"
					// The full name stays when a narrow bar shows only "Workspace".
					aria-label="Back to your workspace"
				>
					<span className="@max-[24rem]:hidden">Back to your workspace</span>
					<span className="hidden @max-[24rem]:inline">Workspace</span>
				</Link>
			)}

			{/* Outside the menu, so it still announces after the menu closes. */}
			{user.role === "administrator" && !workspaceId ? (
				<span
					role="status"
					className={open.isPending ? "text-xs pk-muted" : "sr-only"}
					data-testid="open-my-workspace-status"
				>
					{open.isPending ? "Opening your workspace" : ""}
				</span>
			) : null}

			<span className="pk-account-wrap">
				<MenuRoot>
					<MenuTrigger asChild>
						<button
							type="button"
							className="pk-account"
							data-testid="me"
							ref={accountButton}
							// Named in full here: a hidden span after the name gained a stray space
							// before its comma, and the initials were read as a word.
							aria-label={
								badge ? `${user.displayName}, ${unreadLabel}` : user.displayName
							}
						>
							<AccountPicture picture={picture} displayName={user.displayName} />
							{/* The gap is only visual. This space keeps the text readable when copied. */}{" "}
							{/* On a narrow bar the picture stands for the name; the button's label still says it. */}
							<span
								className={
									nav
										? "pk-account-name @max-7xl:hidden"
										: "pk-account-name @max-[40rem]:hidden"
								}
							>
								{user.displayName}
							</span>
							<Icon name="chevron-down" size="sm" />
						</button>
					</MenuTrigger>
					<Menu label="Account">
						<MenuLabel>
							{/* The name first: a narrow bar shows only the picture. A long name
							    or address is cut, not allowed to widen the menu. */}
							<span
								className="pk-account-line pk-account-line--name"
								title={user.displayName}
								data-testid="account-menu-name"
							>
								{user.displayName}
							</span>
							{user.email ? (
								<span className="pk-account-line" title={user.email}>
									{user.email}
								</span>
							) : null}
						</MenuLabel>
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
						{user.role === "administrator" && !workspaceId ? (
							<>
								<MenuItem
									onSelect={openMyWorkspace}
									disabled={open.isPending}
									testId="open-my-workspace"
								>
									{open.isPending ? "Opening your workspace…" : "Open my workspace"}
								</MenuItem>
								<MenuSeparator />
							</>
						) : null}
						<MenuItem
							onSelect={() => setNotificationsOpen(true)}
							testId="notifications-item"
						>
							<span className="flex items-baseline justify-between gap-4">
								{unread > 0 ? (
									<>
										{/* One spoken name: browsers put spaces around a hidden comma. */}
										<span className="sr-only">Notifications, {unread} unread</span>
										<span aria-hidden="true">Notifications</span>
										<span aria-hidden="true" className="text-xs text-ink-muted">
											{unread} unread
										</span>
									</>
								) : (
									"Notifications"
								)}
							</span>
						</MenuItem>
						<MenuItem onSelect={() => setSettingsOpen(true)}>
							<span data-testid="editor-settings">Settings</span>
						</MenuItem>
						{/* A new tab from everywhere, so the workspace keeps its sockets. */}
						<MenuItem
							icon="help"
							href={helpHref(window.location.pathname)}
							target="_blank"
							rel="noopener"
							testId="help-link"
						>
							Help<span className="sr-only"> (opens in a new tab)</span>
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
				{/* Its own button beside the account button, so a click opens the history directly. */}
				{badge ? (
					<button
						type="button"
						ref={badgeButton}
						className="pk-account-badge"
						data-testid="notifications-badge"
						aria-label={`Notifications, ${unreadLabel}`}
						onClick={() => {
							// Focus the badge so the dialog returns focus to it on close.
							badgeButton.current?.focus();
							setNotificationsOpen(true);
						}}
					>
						<span className="pk-account-badge-pill">{badge}</span>
					</button>
				) : null}
			</span>
			{/* A real form post, so the session cookie is cleared by the server. */}
			<form ref={signOutForm} method="post" action="/auth/logout" className="hidden" />

			{settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
			{notificationsOpen ? (
				<NotificationsDialog
					onClose={() => setNotificationsOpen(false)}
					// Once all is read the badge is gone; the account button always stays.
					returnFocusTo={() =>
						badgeButton.current?.isConnected ? null : accountButton.current
					}
				/>
			) : null}
		</header>
	);
}
