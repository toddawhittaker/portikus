import type { AdminUser } from "@portikus/contracts";
import { Button, ConfirmDialog, ConfirmDialogRoot, useToast } from "@portikus/ui";
import type { UseMutationResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { errorText } from "../../api/request.js";
import { timeAgo } from "../../text.js";
import { DexUserActions } from "../DexUserDialogs.js";
import { isCourseAccount, roleText, sourceText } from "../markers.js";
import {
	useSetDisabled,
	useSetGrantedAdmin,
	useSetGrantedInstructor,
} from "../queries.js";
import { PANEL_HELP, SECTION_HEADING, WithTip } from "./shared.js";

/** Why Promote or Demote is off for this account, or null when it is on (ADR 0026). */
export function roleChangeNote(user: AdminUser, isSelf: boolean): string | null {
	if (user.role !== "administrator") {
		return isCourseAccount(user.issuer)
			? "Only SSO accounts can be administrators."
			: null;
	}
	if (isSelf) return "You cannot demote your own account.";
	if (user.grantedRole !== "administrator") {
		return "This administrator comes from the SSO provider's groups.";
	}
	return null;
}

/** Promote to administrator, or demote a granted one (ADR 0026). */
function RoleChange({ user, isSelf }: { user: AdminUser; isSelf: boolean }) {
	const change = useSetGrantedAdmin();
	const promote = user.role !== "administrator";
	const name = user.displayName;
	return (
		<GrantChange
			change={change}
			variables={{ userId: user.id, admin: promote }}
			name="role"
			verb={promote ? "Promote" : "Demote"}
			note={roleChangeNote(user, isSelf)}
			tip={promote ? PANEL_HELP.promote : null}
			ariaLabel={promote ? `Promote ${name} to administrator` : `Demote ${name}`}
			title={promote ? `Make ${name} an administrator?` : `Demote ${name}?`}
			description={
				promote
					? "They can see every account and workspace and change platform settings, from their next page load."
					: `They go back to ${roleText({ role: user.providerRole, grantedRole: null })}, from their next page load.`
			}
			destructive={!promote}
			successTitle={
				promote
					? `${name} is now an administrator`
					: `${name} is no longer an administrator`
			}
		/>
	);
}

/** The parts of a TanStack mutation a role button uses. */
type GrantMutation<V> = Pick<
	UseMutationResult<unknown, Error, V>,
	"mutate" | "reset" | "isPending" | "error"
>;

/**
 * A button that grants or removes a role after a confirm dialog, with the
 * reason it is off shown beneath it (SPEC.md §20.1). `verb` is the button,
 * tip and confirm wording and gives the test ids; `name` gives the note and
 * error ids.
 */
function GrantChange<V extends { userId: string }>({
	change,
	variables,
	name,
	verb,
	note,
	tip,
	ariaLabel,
	title,
	description,
	destructive,
	successTitle,
}: {
	change: GrantMutation<V>;
	variables: V;
	name: "role" | "instructor";
	verb: string;
	note: string | null;
	tip: string | null;
	ariaLabel: string;
	title: string;
	description: string;
	destructive: boolean;
	successTitle: string;
}) {
	const toast = useToast();
	const [confirming, setConfirming] = useState(false);
	const slug = verb.toLowerCase().replaceAll(" ", "-");
	const noteId = `${name}-note-${variables.userId}`;
	const dialogId = `${slug}-dialog`;

	function open(next: boolean) {
		change.reset();
		setConfirming(next);
	}

	function run() {
		if (change.isPending) return;
		change.mutate(variables, {
			onSuccess: () => {
				toast.show({ tone: "success", title: successTitle });
				setConfirming(false);
			},
		});
	}

	return (
		<>
			<WithTip label={verb} tip={tip}>
				<Button
					size="sm"
					data-testid={`detail-${slug}`}
					aria-label={ariaLabel}
					aria-describedby={note ? noteId : undefined}
					aria-disabled={note ? true : undefined}
					onClick={() => (note ? undefined : open(true))}
				>
					{`${verb}…`}
				</Button>
			</WithTip>
			{note ? (
				<p id={noteId} className="pk-text-compact pk-muted m-0 w-full">
					{note}
				</p>
			) : null}
			<ConfirmDialogRoot open={confirming} onOpenChange={open}>
				<ConfirmDialog
					id={dialogId}
					testId={dialogId}
					title={title}
					description={
						<>
							<span className="block">{description}</span>
							{change.error ? (
								<span
									className="mt-2 block text-status-error"
									role="alert"
									data-testid={`${name}-change-error`}
								>
									{errorText(change.error)}
								</span>
							) : null}
						</>
					}
					confirmLabel={verb}
					destructive={destructive}
					pending={change.isPending}
					onConfirm={run}
				/>
			</ConfirmDialogRoot>
		</>
	);
}

/** Why Make instructor is off for this account, or null when it is on (ADR 0026). */
export function instructorChangeNote(user: AdminUser): string | null {
	if (user.grantedRole === "instructor") return null;
	if (isCourseAccount(user.issuer)) return "Only SSO accounts can be instructors.";
	if (user.grantedRole === "administrator") {
		return "This account is a granted administrator. Demote first.";
	}
	if (user.role !== "student") {
		return `Already ${user.role === "administrator" ? "an administrator" : "an instructor"} from the SSO provider.`;
	}
	return null;
}

/** Make instructor, or remove a granted instructor role (ADR 0026). */
function InstructorChange({ user }: { user: AdminUser }) {
	const change = useSetGrantedInstructor();
	const make = user.grantedRole !== "instructor";
	const name = user.displayName;
	return (
		<GrantChange
			change={change}
			variables={{ userId: user.id, instructor: make }}
			name="instructor"
			verb={make ? "Make instructor" : "Remove instructor"}
			note={instructorChangeNote(user)}
			tip={make ? PANEL_HELP.makeInstructor : null}
			ariaLabel={make ? `Make instructor: ${name}` : `Remove instructor: ${name}`}
			title={make ? `Make ${name} an instructor?` : `Remove instructor from ${name}?`}
			description={
				make
					? "They can open the Course pages of courses they teach, from their next page load."
					: `They go back to ${roleText({ role: user.providerRole, grantedRole: null })}, from their next page load.`
			}
			destructive={false}
			successTitle={
				make ? `${name} is now an instructor` : `${name} is no longer an instructor`
			}
		/>
	);
}

/** Disable or enable the account (SPEC.md §6.4, §20.1). */
export function AccountSection({ user, isSelf }: { user: AdminUser; isSelf: boolean }) {
	const toast = useToast();
	const wasDexLocal = useRef(user.dexLocal);

	// Remove takes the Dex buttons and their dialog away with it; focus then
	// goes to the panel heading rather than being lost (ADR 0028).
	useEffect(() => {
		const lost = document.activeElement === document.body || !document.activeElement;
		if (wasDexLocal.current && !user.dexLocal && lost) {
			document.getElementById("detail-title")?.focus();
		}
		wasDexLocal.current = user.dexLocal;
	}, [user.dexLocal]);
	const setDisabled = useSetDisabled();
	const [confirming, setConfirming] = useState(false);
	const disabled = user.disabledAt !== null;
	const selfNoteId = `self-note-${user.id}`;

	function run(next: boolean) {
		if (setDisabled.isPending) return;
		setDisabled.mutate(
			{ userId: user.id, disabled: next },
			{
				onSuccess: () => {
					toast.show({
						tone: "success",
						title: next
							? `${user.displayName} disabled`
							: `${user.displayName} enabled`,
					});
					setConfirming(false);
				},
				onError: (error) =>
					toast.show({
						tone: "danger",
						title: next
							? "Could not disable the account"
							: "Could not enable the account",
						children: errorText(error),
					}),
			},
		);
	}

	return (
		<section aria-labelledby="detail-account" className="pk-detail-section">
			<h4 id="detail-account" className={SECTION_HEADING}>
				Account
			</h4>
			<dl className="pk-dl">
				<dt>Role</dt>
				<dd data-testid="detail-role">{roleText(user)}</dd>
				<dt>Source</dt>
				<dd>{sourceText(user.issuer)}</dd>
				<dt>Last sign-in</dt>
				<dd data-testid="detail-last-sign-in">
					{user.lastLoginAt ? (
						<time
							dateTime={user.lastLoginAt}
							title={new Date(user.lastLoginAt).toLocaleString()}
						>
							{timeAgo(user.lastLoginAt, Date.now())}
						</time>
					) : (
						"Never"
					)}
				</dd>
				<dt>Username</dt>
				<dd className="pk-mono-small break-all">{user.preferredUsername ?? "—"}</dd>
				<dt>Email</dt>
				<dd className="break-all" data-testid="detail-email">
					{user.email ?? "—"}
				</dd>
				<dt>Issuer</dt>
				<dd className="pk-mono-small break-all" data-testid="detail-issuer">
					{user.issuer ?? "—"}
				</dd>
			</dl>
			<Link
				to="/admin"
				search={{ tab: "logs", user: user.id }}
				className="pk-link pk-text-compact justify-self-start"
				data-testid="detail-user-logs"
			>
				View this user's logs
			</Link>
			<div className="pk-actions">
				<RoleChange user={user} isSelf={isSelf} />
				<InstructorChange user={user} />
				{user.dexLocal ? <DexUserActions user={user} isSelf={isSelf} /> : null}
			</div>
			{/* Disabling is the heaviest action, so it sits alone and last. */}
			<div className="pk-actions">
				<WithTip
					label={disabled ? "Enable account" : "Disable account"}
					tip={disabled ? null : PANEL_HELP.disable}
				>
					<Button
						size="sm"
						data-testid="detail-disable"
						aria-label={`${disabled ? "Enable" : "Disable"} account for ${user.displayName}`}
						aria-describedby={isSelf ? selfNoteId : undefined}
						aria-disabled={isSelf ? true : undefined}
						loading={disabled && setDisabled.isPending}
						onClick={() => {
							if (isSelf) return;
							if (disabled) run(false);
							else setConfirming(true);
						}}
					>
						{disabled ? "Enable account" : "Disable account…"}
					</Button>
				</WithTip>
			</div>
			{isSelf ? (
				<p id={selfNoteId} className="pk-text-compact pk-muted m-0">
					You cannot disable your own account.
				</p>
			) : null}
			<ConfirmDialogRoot open={confirming} onOpenChange={setConfirming}>
				<ConfirmDialog
					id="disable-dialog"
					testId="disable-dialog"
					title={`Disable ${user.displayName}?`}
					description="They are signed out everywhere, their previews close, and their workspace stops. Nothing is deleted."
					confirmLabel="Disable"
					pending={setDisabled.isPending}
					onConfirm={() => run(true)}
				/>
			</ConfirmDialogRoot>
		</section>
	);
}
