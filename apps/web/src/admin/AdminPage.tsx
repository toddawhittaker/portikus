import { type AdminUser, LogLevel } from "@portikus/contracts";
import {
	Button,
	CONTROL_CLASS,
	FIELD_CLASS,
	LABEL_CLASS,
	TextField,
	useToast,
} from "@portikus/ui";
import { Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { ApiError } from "../api/request.js";
import { usePageTitle } from "../pageTitle.js";
import { AppHeader } from "../shell/AppHeader.js";
import { useMe } from "../useMe.js";
import { defaultLabel, graceText } from "./graceText.js";
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
	usePageTitle("Administration");

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
				<LogLevelSection />
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

/** A field error, announced when it appears (issue #363). */
function announced(error: string | null) {
	return error ? <span role="alert">{error}</span> : null;
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
					error={announced(
						error ?? (settings.isError ? errorText(settings.error) : null),
					)}
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

/** The value the select uses for "no override"; the API takes null. */
const SERVICE_DEFAULT = "default";

/**
 * The runtime log level every service follows (ADR 0012). "Use service
 * default" clears the override, so each service falls back to its own
 * LOG_LEVEL from the environment.
 */
function LogLevelSection() {
	const settings = usePlatformSettings();
	const update = useUpdatePlatformSettings();
	const toast = useToast();
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const saved = settings.data?.logLevel ?? null;
	const value = draft ?? (saved === null ? SERVICE_DEFAULT : saved);

	function save() {
		setError(null);
		const parsed = LogLevel.safeParse(value);
		update.mutate(
			{ logLevel: parsed.success ? parsed.data : null },
			{
				onSuccess: () => {
					setDraft(null);
					toast.show({ tone: "success", title: "Log level saved" });
				},
				onError: (failure) => setError(errorText(failure)),
			},
		);
	}

	return (
		<section className="pk-card mt-6 max-w-160 p-6" aria-labelledby="log-level-title">
			<h2 className="pk-text-heading m-0" id="log-level-title">
				Log level
			</h2>
			<p className="pk-text-body pk-muted mt-1">
				How much every service logs. Takes effect within a few seconds.
			</p>
			<div className="pk-actions mt-4 items-end">
				<div className={FIELD_CLASS}>
					<label className={LABEL_CLASS} htmlFor="log-level">
						Level
					</label>
					<select
						id="log-level"
						className={`${CONTROL_CLASS} w-48 cursor-pointer disabled:border-line disabled:bg-surface-sunken disabled:text-ink-faint`}
						data-testid="log-level-select"
						value={value}
						disabled={settings.isLoading}
						aria-invalid={error ? true : undefined}
						aria-describedby={error ? "log-level-err" : undefined}
						onChange={(event) => setDraft(event.target.value)}
					>
						<option value={SERVICE_DEFAULT}>Use service default</option>
						{LogLevel.options.map((level) => (
							<option key={level} value={level}>
								{level}
							</option>
						))}
					</select>
					{error ? (
						<p
							className="pk-error m-0 text-[12px] leading-4 text-status-error"
							id="log-level-err"
							role="alert"
						>
							{error}
						</p>
					) : null}
				</div>
				<Button
					variant="primary"
					data-testid="log-level-save"
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
						label={
							<>
								Seconds
								<span className="pk-visually-hidden">
									{`, grace period for ${user.displayName}`}
								</span>
							</>
						}
						className="w-40"
						inputMode="numeric"
						placeholder={
							globalSeconds === null ? undefined : defaultLabel(globalSeconds)
						}
						data-testid={`user-grace-input-${user.id}`}
						value={value}
						hint={effective === null ? undefined : graceText(effective)}
						error={announced(error)}
						onChange={(event) => setDraft(event.target.value)}
					/>
					<Button
						data-testid={`user-grace-save-${user.id}`}
						loading={update.isPending}
						aria-label={`Save ${user.displayName}`}
						onClick={save}
					>
						Save
					</Button>
				</div>
			</td>
		</tr>
	);
}
