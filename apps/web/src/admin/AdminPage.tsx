import type { AdminUser } from "@portikus/contracts";
import { Button, TextField, useToast } from "@portikus/ui";
import { Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { ApiError } from "../api/request.js";
import { AppHeader } from "../shell/AppHeader.js";
import { useMe } from "../useMe.js";
import { graceText } from "./graceText.js";
import {
	useAdminUsers,
	usePlatformSettings,
	useUpdatePlatformSettings,
	useUpdateUserSettings,
} from "./queries.js";

const ROLE_LABEL = { student: "Student", administrator: "Administrator" } as const;

/** The administration screen. Students never get here (SPEC.md §5.2, §6.4). */
export function AdminPage() {
	const me = useMe();

	if (me.status === "loading") {
		return <div className="pk-root" aria-busy="true" />;
	}
	if (me.status === "anonymous") return <Navigate to="/" />;
	if (me.status === "forbidden") return <Navigate to="/not-authorized" />;
	if (me.user.role !== "administrator") return <Navigate to="/not-authorized" />;

	return (
		<div className="pk-root">
			<AppHeader user={me.user} workspace={null} project={undefined} />
			<main
				className="flex-1 overflow-auto p-8"
				data-testid="page-admin"
				aria-labelledby="admin-title"
			>
				<h1 className="pk-text-title" id="admin-title">
					Administration
				</h1>
				<GraceSection />
				<UsersSection />
			</main>
		</div>
	);
}

/**
 * Reads a seconds input, or null when it is not a whole number at or above 0.
 * The upper bound is the largest value the API's 32-bit integer column takes.
 */
const MAX_SECONDS = 2147483647;

function parseSeconds(value: string): number | null {
	if (!/^\d+$/.test(value.trim())) return null;
	const seconds = Number(value.trim());
	return seconds > MAX_SECONDS ? null : seconds;
}

function errorText(error: unknown): string {
	if (error instanceof ApiError) return error.message;
	return "Something went wrong. Please try again.";
}

function GraceSection() {
	const settings = usePlatformSettings();
	const update = useUpdatePlatformSettings();
	const toast = useToast();
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const current = settings.data?.shutdownGraceSeconds;
	const value = draft ?? (current === undefined ? "" : String(current));
	const seconds = parseSeconds(value);

	function save() {
		if (seconds === null) {
			setError("Enter a whole number of seconds, 0 or more.");
			return;
		}
		setError(null);
		update.mutate(
			{ shutdownGraceSeconds: seconds },
			{
				onSuccess: () => {
					setDraft(null);
					toast.show({ tone: "success", title: "Grace period saved" });
				},
				onError: (failure) => setError(errorText(failure)),
			},
		);
	}

	return (
		<section className="pk-card mt-6 max-w-160 p-6" aria-labelledby="grace-title">
			<h2 className="pk-text-heading m-0" id="grace-title">
				Disconnect grace period
			</h2>
			<p className="pk-text-body pk-muted mt-1">
				How long a workspace keeps running after the last browser disconnects.
			</p>
			<div className="pk-actions mt-4 items-end">
				<TextField
					id="grace-seconds"
					label="Seconds"
					className="w-48"
					inputMode="numeric"
					data-testid="grace-input"
					value={value}
					hint={seconds === null ? undefined : graceText(seconds)}
					error={error ?? (settings.isError ? errorText(settings.error) : null)}
					disabled={settings.isLoading}
					onChange={(event) => setDraft(event.target.value)}
				/>
				<Button
					variant="primary"
					data-testid="grace-save"
					loading={update.isPending}
					onClick={save}
				>
					Save
				</Button>
			</div>
		</section>
	);
}

function UsersSection() {
	const users = useAdminUsers();
	const settings = usePlatformSettings();
	const globalSeconds = settings.data?.shutdownGraceSeconds ?? null;

	return (
		<section className="pk-card mt-6 p-6" aria-labelledby="users-title">
			<h2 className="pk-text-heading m-0" id="users-title">
				Users
			</h2>
			<table className="mt-4 w-full text-left text-[13px]" data-testid="admin-users">
				<thead>
					<tr className="pk-text-label text-ink-muted">
						<th className="py-2 pr-4 font-medium">Name</th>
						<th className="py-2 pr-4 font-medium">Email</th>
						<th className="py-2 pr-4 font-medium">Role</th>
						<th className="py-2 font-medium">Grace period</th>
					</tr>
				</thead>
				<tbody>
					{(users.data ?? []).map((user) => (
						<UserRow key={user.id} user={user} globalSeconds={globalSeconds} />
					))}
				</tbody>
			</table>
		</section>
	);
}

function UserRow({
	user,
	globalSeconds,
}: {
	user: AdminUser;
	globalSeconds: number | null;
}) {
	const update = useUpdateUserSettings();
	const toast = useToast();
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const value =
		draft ??
		(user.shutdownGraceSeconds === null ? "" : String(user.shutdownGraceSeconds));
	const blank = value.trim() === "";
	const seconds = blank ? null : parseSeconds(value);
	const effective = blank ? globalSeconds : seconds;

	function save() {
		if (!blank && seconds === null) {
			setError("Enter a whole number of seconds, 0 or more.");
			return;
		}
		setError(null);
		update.mutate(
			{ userId: user.id, body: { shutdownGraceSeconds: blank ? null : seconds } },
			{
				onSuccess: () => {
					setDraft(null);
					toast.show({ tone: "success", title: `Saved ${user.displayName}` });
				},
				onError: (failure) => setError(errorText(failure)),
			},
		);
	}

	return (
		<tr className="border-line border-t align-top" data-testid={`user-row-${user.id}`}>
			<td className="py-3 pr-4">{user.displayName}</td>
			<td className="py-3 pr-4">{user.email ?? "—"}</td>
			<td className="py-3 pr-4">
				{ROLE_LABEL[user.role]}
				{user.disabledAt ? <span className="pk-tag ml-2">Disabled</span> : null}
			</td>
			<td className="py-3">
				<div className="pk-actions items-end">
					<TextField
						id={`user-grace-${user.id}`}
						label="Seconds"
						className="w-40"
						inputMode="numeric"
						placeholder={
							globalSeconds === null ? undefined : `Default (${globalSeconds} s)`
						}
						data-testid={`user-grace-input-${user.id}`}
						value={value}
						hint={effective === null ? undefined : graceText(effective)}
						error={error}
						onChange={(event) => setDraft(event.target.value)}
					/>
					<Button
						data-testid={`user-grace-save-${user.id}`}
						loading={update.isPending}
						onClick={save}
					>
						Save
					</Button>
				</div>
			</td>
		</tr>
	);
}
