import {
	type AdminNotifications,
	isJobActive,
	jobStaleAt,
	NOTIFY_JOB_STALE_MS,
	type NotifyJobView,
} from "@portikus/contracts";
import { Checkbox, Skeleton } from "@portikus/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, errorText } from "../../api/request.js";
import { longTime } from "../backups/model.js";
import { Notice } from "../Notice.js";
import {
	adminKeys,
	usePlatformSettings,
	useUpdatePlatformSettings,
} from "../queries.js";
import { useRootShellStatus } from "../root-shell/status.js";
import { footerState, SaveFooter } from "../settings/SaveFooter.js";
import { LoadFailed, SectionCard, SectionGroup } from "../settings/SectionCard.js";
import { NotSaved } from "../settings/SettingRow.js";
import { SECTIONS } from "../settings/sections.js";
import { useReportUnsaved } from "../settings/unsaved.js";
import {
	EmailChannel,
	MailServerFields,
	NtfyChannel,
	PushoverChannel,
	TeamsChannel,
	WebhookChannel,
} from "./ChannelFields.js";
import {
	type ClearWarnings,
	changedFields,
	FIELD_ID,
	type FormErrors,
	initialForm,
	isStale,
	jobText,
	type NotifyForm,
	ntfyTokenCleared,
	ntfyTokenWarning,
	SECRET_FIELDS,
	SMTP_PASSWORD_WARNING,
	smtpPasswordCleared,
	toUpdate,
	validate,
} from "./form.js";
import { useNotifications, useSaveNotifications } from "./queries.js";

const SECTION = SECTIONS.mail;
const DESCRIPTION =
	"The mail server Portikus sends through, whether it emails people their account links, and where administrator alerts go. A root job on the server applies each save, and a saved secret is never shown again.";
const UNREADABLE_NOTE =
	"The stored notification settings could not be read, so every channel shows as off. Saving replaces them.";
const BUSY_NOTE = "A change is being applied. Wait until it finishes, then save again.";
const SAVE_NOTE =
	"Every administrator is told of each change, with the alert hosts it uses.";

/** Each field's label, so the footer can name the first one to fix. */
const FIELD_LABEL: Record<string, string> = {
	[FIELD_ID.smtpHost]: "Host name",
	[FIELD_ID.smtpUsername]: "User name",
	[FIELD_ID.smtpPassword]: "Password",
	[FIELD_ID.smtpFrom]: "From",
	[FIELD_ID.emailTo]: "Send to",
	[FIELD_ID.pushoverUserKey]: "User key",
	[FIELD_ID.pushoverAppToken]: "API token",
	[FIELD_ID.ntfyUrl]: "Topic URL",
	[FIELD_ID.ntfyToken]: "Access token",
	[FIELD_ID.teamsUrl]: "Workflows webhook URL",
	[FIELD_ID.webhookUrl]: "Webhook URL",
};

const PORT_TEXT: Record<string, string> = { "587": "587, STARTTLS", "465": "465, TLS" };

/**
 * The saved value of a field in words, for "Not saved. Was …"; null for a
 * secret, which is never quoted, and for a list too long to quote.
 */
export function savedText(field: string, baseline: NotifyForm): string | null {
	if (
		SECRET_FIELDS.has(field) ||
		field === "email.to" ||
		field === "ntfy.removeToken"
	) {
		return null;
	}
	if (field === "rootShellOpenedAlert")
		return baseline.rootShellOpenedAlert ? "on" : "off";
	const [kind, key] = field.split(".") as [keyof NotifyForm, string];
	const value = (baseline[kind] as Record<string, string | boolean>)[key];
	if (typeof value === "boolean") return value ? "on" : "off";
	if (key === "port") return PORT_TEXT[value ?? ""] ?? null;
	return value === undefined || value.trim() === "" ? "empty" : value;
}

/**
 * The mail server, account email, alert channels and root-shell alert
 * (SPEC.md section 5.3, ADR 0051, ADR 0052). Account email is a platform
 * setting; the rest live in a root-owned file, and a save asks the root
 * alerts job to apply them, which this section then follows.
 */
export function MailSection() {
	// The job this page asked for. The API may report an older dead job
	// instead until the new one is taken, so the page follows its own.
	const [requested, setRequested] = useState<NotifyJobView | null>(null);
	const waiting = requested !== null && isJobActive(requested, NOTIFY_JOB_STALE_MS);
	const notifications = useNotifications(waiting);
	const settings = usePlatformSettings();
	const reported = notifications.data?.job ?? null;
	if (requested && reported?.id === requested.id) setRequested(null);
	const job = waiting ? requested : reported;
	useRenderAt(
		isJobActive(job, NOTIFY_JOB_STALE_MS) ? jobStaleAt(job, NOTIFY_JOB_STALE_MS) : null,
	);
	// A site without the alerts job still has account email.
	const off =
		notifications.error instanceof ApiError && notifications.error.status === 404;
	const failed = settings.isError ? settings.error : off ? null : notifications.error;
	const ready = settings.data && (notifications.data || off);

	return (
		<SectionCard section={SECTION} description={DESCRIPTION}>
			{ready ? (
				<MailForm
					data={notifications.data ?? null}
					accountEmail={settings.data.accountEmailEnabled}
					job={job}
					onRequested={setRequested}
				/>
			) : failed ? (
				<LoadFailed
					error={failed}
					retrying={settings.isFetching || notifications.isFetching}
					// The other sections announce a failed read of the platform settings.
					announce={!settings.isError}
					onRetry={() => {
						void settings.refetch();
						void notifications.refetch();
					}}
				/>
			) : (
				<div className="grid gap-5" aria-busy="true" data-testid="notify-loading">
					<Skeleton variant="block" height="8rem" />
					<Skeleton variant="block" height="4rem" />
					<Skeleton variant="block" height="14rem" />
				</div>
			)}
		</SectionCard>
	);
}

function MailForm({
	data,
	accountEmail,
	job,
	onRequested,
}: {
	/** Null when the site runs without the alerts job. */
	data: AdminNotifications | null;
	accountEmail: boolean;
	/** The job to show: the one this page asked for, else the latest the API reports. */
	job: NotifyJobView | null;
	onRequested: (job: NotifyJobView) => void;
}) {
	const client = useQueryClient();
	const save = useSaveNotifications();
	const saveAccount = useUpdatePlatformSettings();
	// The setting stays editable when root shells are off, so it is ready if
	// the operator turns them on; the description says why it does nothing.
	const rootShellsOff = useRootShellStatus(true).data?.enabled === false;
	const view = data?.settings ?? null;
	const [form, setFormState] = useState<NotifyForm | null>(() =>
		view ? initialForm(view) : null,
	);
	// What the page last sent, while the job applies it, so it does not count as unsaved.
	const [sent, setSent] = useState<NotifyForm | null>(null);
	const [accountDraft, setAccountDraft] = useState<boolean | null>(null);
	const [errors, setErrors] = useState<FormErrors>({});
	const [failure, setFailure] = useState<string | null>(null);
	const [justSaved, setJustSaved] = useState(false);
	const [warned, setWarned] = useState<ClearWarnings>({ smtp: false, ntfy: false });
	const [announcement, setAnnouncement] = useState("");
	const focusError = useRef(false);
	// The warnings Save has already stopped for once; a second Save goes ahead.
	const heeded = useRef<ClearWarnings>({ smtp: false, ntfy: false });
	const busy = isJobActive(job, NOTIFY_JOB_STALE_MS);

	// New settings in force after a save: start the form from them. Each poll
	// brings a new object, so they are compared by content.
	const viewText = JSON.stringify(view);
	const [shownView, setShownView] = useState(viewText);
	if (shownView !== viewText) {
		setShownView(viewText);
		setFormState(view ? initialForm(view) : null);
		setSent(null);
		setErrors({});
		setWarned({ smtp: false, ntfy: false });
		setAnnouncement("");
		heeded.current = { smtp: false, ntfy: false };
	}

	useEffect(() => {
		if (!focusError.current) return;
		focusError.current = false;
		const first = Object.keys(errors)[0];
		if (first) document.getElementById(first)?.focus();
	}, [errors]);

	const baseline = view ? (busy && sent ? sent : initialForm(view)) : null;
	const changed = form && baseline ? changedFields(form, baseline) : [];
	const account = accountDraft ?? accountEmail;
	const accountChanged = account !== accountEmail;
	const count = changed.length + (accountChanged ? 1 : 0);
	useReportUnsaved(SECTION.title, count);

	function edited() {
		setFailure(null);
		setJustSaved(false);
	}

	function setForm(next: NotifyForm) {
		setFormState(next);
		edited();
	}

	/**
	 * Work out the "stored secret will be cleared" warnings when a field that
	 * causes one is left, not on each key press, and read out each one that is new.
	 */
	function checkWarnings(next: NotifyForm | null = form): ClearWarnings {
		if (!next || !view) return { smtp: false, ntfy: false };
		const now = {
			smtp: smtpPasswordCleared(next, view),
			ntfy: ntfyTokenCleared(next, view),
		};
		const fresh = [
			now.smtp && !warned.smtp ? SMTP_PASSWORD_WARNING : null,
			now.ntfy && !warned.ntfy ? ntfyTokenWarning(view) : null,
		].filter((line): line is string => line !== null);
		// A warning that went away is cleared, so the same text is read out again if it returns.
		if ((warned.smtp && !now.smtp) || (warned.ntfy && !now.ntfy)) setAnnouncement("");
		if (!now.smtp) heeded.current.smtp = false;
		if (!now.ntfy) heeded.current.ntfy = false;
		setWarned(now);
		if (fresh.length > 0) setAnnouncement(fresh.join(" "));
		return now;
	}

	function clearError(id: string) {
		setErrors((now) => {
			if (!(id in now)) return now;
			const { [id as keyof FormErrors]: _, ...rest } = now;
			return rest;
		});
	}

	function discard() {
		if (view) setFormState(baseline ?? initialForm(view));
		setAccountDraft(null);
		setErrors({});
		setFailure(null);
		setWarned({ smtp: false, ntfy: false });
		setAnnouncement("");
		heeded.current = { smtp: false, ntfy: false };
	}

	/** Send the alert settings to the root job, once account email is saved. */
	function sendNotifications(next: NotifyForm, accountSaved: boolean) {
		save.mutate(toUpdate(next), {
			onSuccess: (queued) => {
				onRequested(queued);
				// The secrets are with the job now; the page keeps none of them.
				const kept = {
					...next,
					email: { ...next.email, password: "" },
					pushover: { ...next.pushover, userKey: "", appToken: "" },
					ntfy: { ...next.ntfy, url: "", token: "", removeToken: false },
					teams: { ...next.teams, url: "" },
					webhook: { ...next.webhook, url: "" },
				};
				setFormState(kept);
				setSent(kept);
				save.reset();
			},
			onError: (error) => {
				setFailure(
					accountSaved
						? `Account email was saved, but the mail server and alert settings were not. ${errorText(error)}`
						: errorText(error),
				);
				save.reset();
			},
		});
	}

	function submit(event: FormEvent) {
		event.preventDefault();
		if (count === 0 || save.isPending || saveAccount.isPending) return;
		const alertsChanged = changed.length > 0 && form !== null && view !== null;
		// One change at a time: account email waits with the rest.
		if (busy) return;
		if (alertsChanged) {
			// Enter in a field, or a click on Save straight from it, skips the
			// field's blur; a secret is never cleared before its warning is seen once.
			const now = checkWarnings(form);
			const unheeded = (["smtp", "ntfy"] as const).find(
				(kind) => now[kind] && !heeded.current[kind],
			);
			if (unheeded) {
				heeded.current[unheeded] = true;
				setFailure(null);
				document
					.getElementById(
						unheeded === "ntfy" ? FIELD_ID.ntfyToken : FIELD_ID.smtpPassword,
					)
					?.focus();
				return;
			}
			const found = validate(form, view);
			setErrors(found);
			setFailure(null);
			if (Object.keys(found).length > 0) {
				focusError.current = true;
				return;
			}
		}
		const next = form;
		if (accountChanged) {
			// Account email first: it is quick and needs no job.
			saveAccount.mutate(
				{ accountEmailEnabled: account },
				{
					onSuccess: (saved) => {
						client.setQueryData(adminKeys.settings, saved);
						setAccountDraft(null);
						if (alertsChanged && next) sendNotifications(next, true);
						else setJustSaved(true);
					},
					onError: (error) => setFailure(errorText(error)),
				},
			);
		} else if (alertsChanged && next) {
			sendNotifications(next, false);
		}
	}

	const notSaved = (field: string) =>
		baseline && changed.includes(field) ? (
			<NotSaved was={savedText(field, baseline)} />
		) : null;
	const parts =
		form && view
			? {
					form,
					view,
					errors,
					onChange: setForm,
					onEdit: clearError,
					warned,
					onCheck: checkWarnings,
					notSaved,
					isChanged: (field: string) => changed.includes(field),
				}
			: null;
	const firstError = Object.keys(errors)[0];
	return (
		<form
			className="grid min-w-0 gap-5"
			noValidate
			aria-labelledby={SECTION.id}
			onSubmit={submit}
		>
			{/* Always mounted, so a warning written here is read out (SPEC.md section 25.8). */}
			<p role="status" className="sr-only" data-testid="notify-warning-announce">
				{announcement}
			</p>
			{data?.storedFileUnreadable && (
				<Notice tone="warning" testId="notify-unreadable">
					{UNREADABLE_NOTE}
				</Notice>
			)}
			{parts ? (
				<SectionGroup
					id="mail-server-title"
					title="Mail server"
					description="Used for account email and email alerts. TLS is required, and the server's certificate must be valid."
				>
					<MailServerFields {...parts} />
				</SectionGroup>
			) : (
				<p className="pk-text-compact m-0" data-testid="notify-off">
					This site runs without the alerts job, so the mail server and alert channels
					cannot be set here.
				</p>
			)}
			<SectionGroup id="account-email-title" title="Account email">
				<Checkbox
					label="Email password reset and invitation links"
					description={
						<>
							Sends through the mail server above. When off, no reset or invitation link
							is ever emailed. Setting up the mail server for alerts alone never emails
							students.
							{accountChanged ? <NotSaved was={accountEmail ? "on" : "off"} /> : null}
						</>
					}
					checked={account}
					onChange={(event) => {
						setAccountDraft(event.target.checked);
						edited();
					}}
				/>
			</SectionGroup>
			{parts ? (
				<>
					<SectionGroup
						id="alert-channels-title"
						title="Alert channels"
						description="Warnings and failures that need a person appear on the admin bell, and also go to each channel ticked here."
					>
						<ul
							className="m-0 grid list-none divide-y divide-line border-y border-line p-0"
							data-testid="notify-channels"
						>
							<EmailChannel {...parts} />
							<PushoverChannel {...parts} />
							<NtfyChannel {...parts} />
							<TeamsChannel {...parts} />
							<WebhookChannel {...parts} />
						</ul>
					</SectionGroup>
					<SectionGroup id="root-shell-alert-title" title="Root shell">
						<Checkbox
							label="Alert when a root shell opens"
							description={
								<>
									Sends a warning naming the administrator each time anyone opens a root
									shell.
									{rootShellsOff ? " Root shells are off on this server." : ""}
									{notSaved("rootShellOpenedAlert")}
								</>
							}
							checked={parts.form.rootShellOpenedAlert}
							onChange={(event) =>
								setForm({ ...parts.form, rootShellOpenedAlert: event.target.checked })
							}
						/>
					</SectionGroup>
				</>
			) : null}
			<SaveFooter
				id={SECTION.id}
				count={count}
				state={footerState({
					count,
					firstError: firstError ? (FIELD_LABEL[firstError] ?? null) : null,
					failure,
					justSaved,
				})}
				note={SAVE_NOTE}
				busy={busy ? BUSY_NOTE : undefined}
				saveLabel="Save email and alerts"
				pending={save.isPending || saveAccount.isPending}
				onDiscard={discard}
			>
				{/* Always mounted, so each change of the job's state is read out (SPEC.md section 25.8). */}
				<div role="status" data-testid="notify-job">
					{job ? <JobLine job={job} /> : null}
				</div>
			</SaveFooter>
		</form>
	);
}

function JobLine({ job }: { job: NotifyJobView }) {
	const text = jobText(job);
	if (isJobActive(job, NOTIFY_JOB_STALE_MS))
		return <Notice tone="pending">{text}</Notice>;
	if (isStale(job)) return <Notice tone="warning">{text}</Notice>;
	if (job.state === "succeeded") {
		return (
			<p className="pk-muted m-0">
				{job.finishedAt ? `Applied ${longTime(job.finishedAt)}. ` : "Applied. "}
				The new settings are in use.
			</p>
		);
	}
	return <Notice tone="error">{text}</Notice>;
}

/**
 * Render again at `at`: a dead job stops the polling, so nothing else would
 * redraw the page when it turns stale.
 */
function useRenderAt(at: number | null) {
	const [, setTick] = useState(0);
	useEffect(() => {
		if (at === null || Number.isNaN(at)) return;
		const timer = setTimeout(
			() => setTick((n) => n + 1),
			Math.max(0, at - Date.now()) + 50,
		);
		return () => clearTimeout(timer);
	}, [at]);
}
