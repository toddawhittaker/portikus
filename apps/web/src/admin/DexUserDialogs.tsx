import { type AdminUser, CreateDexUserRequest, type Role } from "@portikus/contracts";
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
import { useAddDexUser, useRemoveDexUser, useResetDexPassword } from "./queries.js";
import { errorText } from "./SettingsTab.js";

/** Standalone Dex users in the Users view (docs/archive/epics/EPIC-14.md rulings 21 and 22). */

export const PASSWORD_ONCE_TEXT =
	"Give this to them privately. It will not be shown again.";

const ROLE_LABEL: Record<Role, string> = {
	student: "Student",
	instructor: "Instructor",
	administrator: "Administrator",
};

/** A generated password, shown once with a Copy button. */
function PasswordOnce({ password }: { password: string }) {
	const toast = useToast();

	async function copy() {
		try {
			await navigator.clipboard.writeText(password);
			toast.show({ tone: "success", title: "Password copied" });
		} catch {
			toast.show({
				tone: "danger",
				title: "Could not copy. Select the password instead.",
			});
		}
	}

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<code className="pk-techdetail select-all" data-testid="dex-password">
					{password}
				</code>
				<Button size="sm" onClick={() => void copy()}>
					Copy password
				</Button>
			</div>
		</div>
	);
}

/** The error of a dialog's last request, announced when it appears. */
function DialogError({ error }: { error: unknown }) {
	if (!error) return null;
	return (
		<p
			className="m-0 mt-3 text-status-error"
			role="alert"
			data-testid="dex-dialog-error"
		>
			{errorText(error)}
		</p>
	);
}

type AddField = "email" | "username";

const ADD_FIELD_ERROR: Record<AddField, string> = {
	email: "Enter an email address.",
	username:
		"Use 1 to 64 letters, digits, dots, dashes or underscores for the username.",
};

/** "Add user…" above the table, and its dialog. */
export function AddDexUser() {
	const add = useAddDexUser();
	const [open, setOpen] = useState(false);
	const [email, setEmail] = useState("");
	const [username, setUsername] = useState("");
	const [role, setRole] = useState<Role>("student");
	const [errors, setErrors] = useState<Partial<Record<AddField, string>>>({});
	const [attempt, setAttempt] = useState(0);
	const created = add.data ?? null;

	function change(next: boolean) {
		if (add.isPending) return;
		if (next) {
			add.reset();
			setEmail("");
			setUsername("");
			setRole("student");
			setErrors({});
		}
		setOpen(next);
	}

	function submit() {
		if (add.isPending) return;
		const body = CreateDexUserRequest.safeParse({ email, username, role });
		if (!body.success) {
			const found: Partial<Record<AddField, string>> = {};
			for (const issue of body.error.issues) {
				const field = issue.path[0] as AddField;
				found[field] = ADD_FIELD_ERROR[field];
			}
			// Render the invalid state before focus lands, so it is announced.
			flushSync(() => setErrors(found));
			// Blur first so focusing an already-focused field reads its error again.
			const input = document.getElementById(
				found.email ? "dex-add-email" : "dex-add-username",
			);
			input?.blur();
			input?.focus();
			return;
		}
		setErrors({});
		setAttempt((n) => n + 1);
		add.mutate(body.data);
	}

	return (
		<>
			<Button size="sm" data-testid="dex-add-user" onClick={() => change(true)}>
				Add user…
			</Button>
			<DialogRoot open={open} onOpenChange={change}>
				{created ? (
					<Dialog
						testId="dex-add-dialog"
						title={`${created.user.displayName} added`}
						description={PASSWORD_ONCE_TEXT}
						footer={
							<Button variant="primary" onClick={() => change(false)}>
								Done
							</Button>
						}
					>
						<PasswordOnce password={created.password} />
					</Dialog>
				) : (
					<Dialog
						testId="dex-add-dialog"
						title="Add user"
						description="A Dex password is made for them. They sign in with their email and it."
						footer={
							<>
								<Button onClick={() => change(false)}>Cancel</Button>
								<Button
									variant="primary"
									data-testid="dex-add-submit"
									loading={add.isPending}
									onClick={submit}
								>
									Add user
								</Button>
							</>
						}
					>
						<form
							className="flex flex-col gap-3"
							onSubmit={(event) => {
								event.preventDefault();
								submit();
							}}
						>
							<TextField
								id="dex-add-email"
								label="Email"
								type="email"
								autoComplete="off"
								data-testid="dex-add-email"
								error={errors.email}
								value={email}
								onChange={(event) => setEmail(event.target.value)}
							/>
							<TextField
								id="dex-add-username"
								label="Username"
								autoComplete="off"
								mono
								data-testid="dex-add-username"
								error={errors.username}
								value={username}
								onChange={(event) => setUsername(event.target.value)}
							/>
							<div className={FIELD_CLASS}>
								<label className={LABEL_CLASS} htmlFor="dex-add-role">
									Role
								</label>
								<select
									id="dex-add-role"
									className={`${CONTROL_CLASS} w-44 cursor-pointer`}
									data-testid="dex-add-role"
									value={role}
									onChange={(event) => setRole(event.target.value as Role)}
								>
									{(["student", "instructor", "administrator"] as const).map(
										(value) => (
											<option key={value} value={value}>
												{ROLE_LABEL[value]}
											</option>
										),
									)}
								</select>
							</div>
							{/* Enter in a field submits. */}
							<button type="submit" hidden />
						</form>
						<DialogError key={attempt} error={add.error} />
					</Dialog>
				)}
			</DialogRoot>
		</>
	);
}

/** Reset password and Remove for one Dex local account, in the detail panel. */
export function DexUserActions({ user, isSelf }: { user: AdminUser; isSelf: boolean }) {
	const toast = useToast();
	const reset = useResetDexPassword();
	const remove = useRemoveDexUser();
	const [dialog, setDialog] = useState<"reset" | "remove" | null>(null);
	const name = user.displayName;
	const selfNoteId = `dex-self-note-${user.id}`;
	const selfResetNoteId = `dex-self-reset-note-${user.id}`;
	const newPassword = reset.data?.password ?? null;

	function openReset(next: boolean) {
		if (reset.isPending) return;
		reset.reset();
		setDialog(next ? "reset" : null);
	}

	function openRemove(next: boolean) {
		if (remove.isPending) return;
		remove.reset();
		setDialog(next ? "remove" : null);
	}

	async function runRemove() {
		if (remove.isPending) return;
		try {
			// Awaited rather than an onSuccess callback: the refetch unmounts this
			// component, and React Query drops the callbacks of an unmounted caller.
			await remove.mutateAsync({ userId: user.id });
		} catch {
			// The dialog shows remove.error.
			return;
		}
		toast.show({ tone: "success", title: `${name} removed` });
		// The refetch has taken these buttons away; AccountSection moves focus.
		setDialog(null);
	}

	return (
		<>
			<Button
				size="sm"
				data-testid="detail-dex-reset"
				aria-label={`Reset password for ${name}`}
				aria-describedby={isSelf ? selfResetNoteId : undefined}
				aria-disabled={isSelf ? true : undefined}
				onClick={() => (isSelf ? undefined : openReset(true))}
			>
				Reset password…
			</Button>
			<Button
				size="sm"
				data-testid="detail-dex-remove"
				aria-label={`Remove user ${name}`}
				aria-describedby={isSelf ? selfNoteId : undefined}
				aria-disabled={isSelf ? true : undefined}
				onClick={() => (isSelf ? undefined : openRemove(true))}
			>
				Remove user…
			</Button>
			{isSelf ? (
				<>
					<p id={selfResetNoteId} className="pk-muted m-0 w-full text-[13px]">
						You cannot reset your own password here.
					</p>
					<p id={selfNoteId} className="pk-muted m-0 w-full text-[13px]">
						You cannot remove your own account.
					</p>
				</>
			) : null}

			<DialogRoot open={dialog === "reset"} onOpenChange={openReset}>
				{newPassword ? (
					<Dialog
						testId="dex-reset-dialog"
						title={`New password for ${name}`}
						description={PASSWORD_ONCE_TEXT}
						footer={
							<Button variant="primary" onClick={() => openReset(false)}>
								Done
							</Button>
						}
					>
						<PasswordOnce password={newPassword} />
					</Dialog>
				) : (
					<Dialog
						testId="dex-reset-dialog"
						title={`Reset the password for ${name}?`}
						description="A new password replaces the old one, and they are signed out everywhere."
						footer={
							<>
								<Button onClick={() => openReset(false)}>Cancel</Button>
								<Button
									variant="primary"
									data-testid="dex-reset-confirm"
									loading={reset.isPending}
									onClick={() =>
										reset.isPending ? undefined : reset.mutate({ userId: user.id })
									}
								>
									Reset password
								</Button>
							</>
						}
					>
						<DialogError error={reset.error} />
					</Dialog>
				)}
			</DialogRoot>

			<ConfirmDialogRoot open={dialog === "remove"} onOpenChange={openRemove}>
				<ConfirmDialog
					id="dex-remove-dialog"
					testId="dex-remove-dialog"
					title={`Remove ${name}?`}
					description={
						<>
							<span className="block">
								Their Dex password is deleted and the account is disabled. The workspace
								stays for you to archive.
							</span>
							{remove.error ? (
								<span
									className="mt-2 block text-status-error"
									role="alert"
									data-testid="dex-dialog-error"
								>
									{errorText(remove.error)}
								</span>
							) : null}
						</>
					}
					confirmLabel="Remove"
					pending={remove.isPending}
					onConfirm={() => void runRemove()}
				/>
			</ConfirmDialogRoot>
		</>
	);
}
