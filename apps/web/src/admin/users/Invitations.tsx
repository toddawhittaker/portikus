import {
	CreateInvitationRequest,
	type Invitation,
	type Role,
} from "@portikus/contracts";
import {
	Button,
	CONTROL_CLASS,
	ConfirmDialog,
	ConfirmDialogRoot,
	Dialog,
	DialogRoot,
	FIELD_CLASS,
	LABEL_CLASS,
	TextField,
	useToast,
} from "@portikus/ui";
import { useState } from "react";
import { flushSync } from "react-dom";
import { errorText } from "../../api/request.js";
import {
	useCreateInvitation,
	useInvitations,
	useRevokeInvitation,
} from "../queries.js";
import type { AccountFilters } from "./filters.js";

/** Invitations in the Users view: the only way an SSO account is made (SPEC.md section 24.13). */

const ROLE_LABEL: Record<Role, string> = {
	student: "Student",
	instructor: "Instructor",
	administrator: "Administrator",
};

type Field = "name" | "email" | "username";

const FIELD_ERROR: Record<Field, string> = {
	name: "Enter a name of 1 to 100 characters.",
	email: "Enter an email address.",
	username: "Enter a sign-in name of at most 254 characters, or leave it empty.",
};

/** "Invite…" above the table, and its dialog. */
export function InviteUser() {
	const toast = useToast();
	const create = useCreateInvitation();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [username, setUsername] = useState("");
	const [role, setRole] = useState<Role>("student");
	const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
	const [attempt, setAttempt] = useState(0);

	function change(next: boolean) {
		if (create.isPending) return;
		if (next) {
			create.reset();
			setName("");
			setEmail("");
			setUsername("");
			setRole("student");
			setErrors({});
		}
		setOpen(next);
	}

	async function submit() {
		if (create.isPending) return;
		const body = CreateInvitationRequest.safeParse({
			name,
			email,
			role,
			...(username.trim() ? { username } : {}),
		});
		if (!body.success) {
			const found: Partial<Record<Field, string>> = {};
			for (const issue of body.error.issues) {
				const field = issue.path[0] as Field;
				found[field] = FIELD_ERROR[field];
			}
			// Render the invalid state before focus lands, so it is announced.
			flushSync(() => setErrors(found));
			const first = (["name", "email", "username"] as const).find((f) => found[f]);
			const input = document.getElementById(`invite-${first}`);
			input?.blur();
			input?.focus();
			return;
		}
		setErrors({});
		setAttempt((n) => n + 1);
		try {
			await create.mutateAsync(body.data);
		} catch {
			// The dialog shows create.error.
			return;
		}
		toast.show({ tone: "success", title: `${body.data.name} invited` });
		setOpen(false);
	}

	return (
		<>
			<Button size="sm" data-testid="invite-user" onClick={() => change(true)}>
				Invite…
			</Button>
			<DialogRoot open={open} onOpenChange={change}>
				<Dialog
					testId="invite-dialog"
					title="Invite someone"
					description="Nobody can sign up on their own. Their first sign-in with a matching email creates the account with this role."
					footer={
						<>
							<Button onClick={() => change(false)}>Cancel</Button>
							<Button
								variant="primary"
								data-testid="invite-submit"
								loading={create.isPending}
								onClick={() => void submit()}
							>
								Invite
							</Button>
						</>
					}
				>
					<form
						className="flex flex-col gap-3"
						onSubmit={(event) => {
							event.preventDefault();
							void submit();
						}}
					>
						<TextField
							id="invite-name"
							label="Name"
							autoComplete="off"
							data-testid="invite-name"
							aria-required="true"
							error={errors.name}
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
						<TextField
							id="invite-email"
							label="Email"
							type="email"
							autoComplete="off"
							data-testid="invite-email"
							aria-required="true"
							error={errors.email}
							value={email}
							onChange={(event) => setEmail(event.target.value)}
						/>
						<TextField
							id="invite-username"
							label="Sign-in name (optional)"
							autoComplete="off"
							mono
							data-testid="invite-username"
							hint="For Microsoft Entra or LDAP: the user principal name or username they sign in with. Leave empty to match the email."
							error={errors.username}
							value={username}
							onChange={(event) => setUsername(event.target.value)}
						/>
						<div className={FIELD_CLASS}>
							<label className={LABEL_CLASS} htmlFor="invite-role">
								Role
							</label>
							<select
								id="invite-role"
								className={`${CONTROL_CLASS} w-44 cursor-pointer`}
								data-testid="invite-role"
								value={role}
								onChange={(event) => setRole(event.target.value as Role)}
							>
								{(["student", "instructor", "administrator"] as const).map((value) => (
									<option key={value} value={value}>
										{ROLE_LABEL[value]}
									</option>
								))}
							</select>
						</div>
						{/* Enter in a field submits. */}
						<button type="submit" hidden />
					</form>
					{create.error ? (
						<p
							key={attempt}
							className="m-0 mt-3 text-status-error"
							role="alert"
							data-testid="invite-error"
						>
							{errorText(create.error)}
						</p>
					) : null}
				</Dialog>
			</DialogRoot>
		</>
	);
}

/**
 * The invitations a filter leaves: the search and role filters apply; a
 * workspace or image filter hides them all, since nobody invited has a workspace.
 */
export function filterInvitations(
	list: Invitation[],
	filters: AccountFilters,
): Invitation[] {
	if (filters.state !== "all" && filters.state !== "none") return [];
	if (filters.image !== "all") return [];
	const needle = filters.text.trim().toLowerCase();
	return list.filter((invitation) => {
		if (filters.role !== "all" && invitation.role !== filters.role) return false;
		if (needle === "") return true;
		return [invitation.displayName, invitation.email, invitation.username].some(
			(field) => field?.toLowerCase().includes(needle),
		);
	});
}

/** Invited people who have not signed in yet, as rows at the end of the Users table. */
export function InvitedRows({ filters }: { filters: AccountFilters }) {
	const invitations = useInvitations();
	const list = filterInvitations(invitations.data?.invitations ?? [], filters);
	return (
		<>
			{list.map((invitation) => (
				<InvitationRow key={invitation.id} invitation={invitation} />
			))}
		</>
	);
}

function InvitationRow({ invitation }: { invitation: Invitation }) {
	const toast = useToast();
	const revoke = useRevokeInvitation();
	const [open, setOpen] = useState(false);
	const name = invitation.displayName;

	function change(next: boolean) {
		if (revoke.isPending) return;
		revoke.reset();
		setOpen(next);
	}

	async function run() {
		if (revoke.isPending) return;
		try {
			// Awaited: the refetch unmounts this row, which drops onSuccess callbacks.
			await revoke.mutateAsync({ id: invitation.id });
		} catch {
			return;
		}
		toast.show({ tone: "success", title: `Invitation for ${name} revoked` });
		setOpen(false);
		document.getElementById("admin-accounts-caption")?.focus();
	}

	return (
		<tr className="align-top" data-testid={`invitation-${invitation.email}`}>
			{/* Nothing to select: bulk actions act on accounts. */}
			<td className="py-2" />
			<td className="py-2 whitespace-normal">
				<div className="pk-cell-stack">
					<span className="pk-cell-primary flex-wrap gap-x-2 gap-y-1">
						<span className="font-semibold text-ink [overflow-wrap:anywhere]">
							{name}
						</span>
						<span className="pk-tag">Invited</span>
					</span>
					<span
						className="pk-cell-secondary block w-0 min-w-full truncate"
						title={invitation.username ?? invitation.email}
					>
						{invitation.username ?? invitation.email}
					</span>
				</div>
			</td>
			<td className="py-2 whitespace-normal">{ROLE_LABEL[invitation.role]}</td>
			<td className="py-2">
				<span className="pk-muted">No workspace</span>
			</td>
			<td className="py-2 whitespace-normal">Not signed in yet</td>
			<td className="pk-cell-actions py-2">
				<Button
					size="sm"
					aria-label={`Revoke the invitation for ${name}`}
					data-testid="invitation-revoke"
					onClick={() => change(true)}
				>
					Revoke…
				</Button>
				<ConfirmDialogRoot open={open} onOpenChange={change}>
					<ConfirmDialog
						id={`invitation-revoke-${invitation.id}`}
						testId="invitation-revoke-dialog"
						title={`Revoke the invitation for ${name}?`}
						description={
							<>
								<span className="block">
									They will not be able to sign in. You can invite them again later.
								</span>
								{revoke.error ? (
									<span className="mt-2 block text-status-error" role="alert">
										{errorText(revoke.error)}
									</span>
								) : null}
							</>
						}
						confirmLabel="Revoke"
						pending={revoke.isPending}
						onConfirm={() => void run()}
					/>
				</ConfirmDialogRoot>
			</td>
		</tr>
	);
}
