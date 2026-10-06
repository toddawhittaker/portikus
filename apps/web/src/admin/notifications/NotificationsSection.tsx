import type { AdminNotifications, NotifyJobView } from "@portikus/contracts";
import { Button, Checkbox, Skeleton } from "@portikus/ui";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, errorText } from "../../api/request.js";
import { AdminGroup } from "../AdminSection.js";
import { longTime } from "../backups/model.js";
import { Notice } from "../Notice.js";
import {
	EmailChannel,
	NtfyChannel,
	PushoverChannel,
	TeamsChannel,
	WebhookChannel,
} from "./ChannelFields.js";
import {
	type FormErrors,
	initialForm,
	isActive,
	isStale,
	jobText,
	type NotifyForm,
	staleAt,
	toUpdate,
	validate,
} from "./form.js";
import { useNotifications, useSaveNotifications } from "./queries.js";

const BUSY_NOTE = "A change is being applied. Wait until it finishes, then save again.";

/**
 * Where administrator alerts go, and the alert when a root shell opens
 * (ADR 0051, ADR 0052). Settings live in a root-owned file; a save asks the
 * root alerts job to apply them and this section follows that job.
 */
export function NotificationsSection() {
	// The job this page asked for. The API may report an older dead job
	// instead until the new one is taken, so the page follows its own.
	const [requested, setRequested] = useState<NotifyJobView | null>(null);
	const waiting = requested !== null && isActive(requested);
	const notifications = useNotifications(waiting);
	const reported = notifications.data?.job ?? null;
	if (requested && reported?.id === requested.id) setRequested(null);
	const job = waiting ? requested : reported;
	useRenderAt(isActive(job) ? staleAt(job) : null);
	return (
		<AdminGroup
			id="notify-title"
			title="Notifications"
			description="Warnings and failures that need a person appear on the admin bell and are also sent to each channel turned on here."
			testId="notify-section"
		>
			{notifications.data ? (
				<NotificationsForm
					data={notifications.data}
					job={job}
					onRequested={setRequested}
				/>
			) : notifications.isError ? (
				notifications.error instanceof ApiError &&
				notifications.error.status === 404 ? (
					<p className="pk-text-compact m-0" data-testid="notify-off">
						This site runs without the alerts job, so alert channels cannot be set here.
					</p>
				) : (
					<p className="pk-text-compact m-0 text-status-error" role="alert">
						{errorText(notifications.error)}
					</p>
				)
			) : (
				<div className="grid gap-4" aria-busy="true" data-testid="notify-loading">
					<Skeleton variant="block" height={96} />
					<Skeleton variant="block" height={96} />
				</div>
			)}
		</AdminGroup>
	);
}

function NotificationsForm({
	data,
	job,
	onRequested,
}: {
	data: AdminNotifications;
	/** The job to show: the one this page asked for, else the latest the API reports. */
	job: NotifyJobView | null;
	onRequested: (job: NotifyJobView) => void;
}) {
	const save = useSaveNotifications();
	const view = data.settings;
	const [form, setFormState] = useState<NotifyForm>(() => initialForm(view));
	const [errors, setErrors] = useState<FormErrors>({});
	const [failure, setFailure] = useState<string | null>(null);
	const focusError = useRef(false);
	const busy = isActive(job);

	// New settings in force after a save: start the form from them. Each poll
	// brings a new object, so they are compared by content.
	const viewText = JSON.stringify(view);
	const [shownView, setShownView] = useState(viewText);
	if (shownView !== viewText) {
		setShownView(viewText);
		setFormState(initialForm(view));
		setErrors({});
	}

	useEffect(() => {
		if (!focusError.current) return;
		focusError.current = false;
		const first = Object.keys(errors)[0];
		if (first) document.getElementById(first)?.focus();
	}, [errors]);

	function setForm(next: NotifyForm) {
		setFormState(next);
		setFailure(null);
	}

	function clearError(id: string) {
		setErrors((now) => {
			if (!(id in now)) return now;
			const { [id as keyof FormErrors]: _, ...rest } = now;
			return rest;
		});
	}

	function submit(event: FormEvent) {
		event.preventDefault();
		if (busy) return;
		const found = validate(form, view);
		setErrors(found);
		setFailure(null);
		if (Object.keys(found).length > 0) {
			focusError.current = true;
			return;
		}
		save.mutate(toUpdate(form), {
			onSuccess: (queued) => {
				onRequested(queued);
				// The secrets are with the job now; the page keeps none of them.
				setFormState((now) => ({
					...now,
					email: { ...now.email, password: "" },
					pushover: { ...now.pushover, userKey: "", appToken: "" },
					ntfy: { ...now.ntfy, url: "", token: "", removeToken: false },
					teams: { ...now.teams, url: "" },
					webhook: { ...now.webhook, url: "" },
				}));
				save.reset();
			},
			onError: (error) => {
				setFailure(errorText(error));
				save.reset();
			},
		});
	}

	const parts = { form, view, errors, onChange: setForm, onEdit: clearError };
	return (
		<form
			className="grid gap-6"
			noValidate
			aria-labelledby="notify-title"
			onSubmit={submit}
		>
			<EmailChannel {...parts} />
			<PushoverChannel {...parts} />
			<NtfyChannel {...parts} />
			<TeamsChannel {...parts} />
			<WebhookChannel {...parts} />

			<fieldset
				className="m-0 grid min-w-0 gap-3 border-0 p-0"
				data-testid="notify-events"
			>
				<legend className="pk-text-body m-0 p-0 font-semibold">Root shell</legend>
				<Checkbox
					label="Alert when a root shell opens"
					description="Sends a warning, naming the administrator, each time anyone opens a root shell on the Root shell tab."
					checked={form.rootShellOpenedAlert}
					onChange={(event) =>
						setForm({ ...form, rootShellOpenedAlert: event.target.checked })
					}
				/>
			</fieldset>

			<div className="grid gap-3">
				<div className="pk-actions items-center">
					<Button
						type="submit"
						variant="primary"
						data-testid="notify-save"
						loading={save.isPending}
						aria-disabled={busy ? true : undefined}
						aria-describedby={busy ? "notify-busy-note" : "notify-save-note"}
					>
						Save notification settings
					</Button>
					<p
						className="pk-text-compact pk-muted m-0"
						id={busy ? "notify-busy-note" : "notify-save-note"}
					>
						{busy
							? BUSY_NOTE
							: "Every administrator is told of each change, with the alert hosts it uses."}
					</p>
				</div>
				{failure ? (
					<p
						className="pk-text-compact m-0 text-status-error [overflow-wrap:anywhere]"
						role="alert"
						data-testid="notify-error"
					>
						{failure}
					</p>
				) : null}
				{/* Always mounted, so each change of the job's state is read out (SPEC.md section 25.8). */}
				<div role="status" data-testid="notify-job">
					{job ? <JobLine job={job} /> : null}
				</div>
			</div>
		</form>
	);
}

function JobLine({ job }: { job: NotifyJobView }) {
	const text = jobText(job);
	if (isActive(job)) return <Notice tone="pending">{text}</Notice>;
	if (isStale(job)) return <Notice tone="warning">{text}</Notice>;
	if (job.state === "succeeded") {
		return (
			<p className="pk-text-compact pk-muted m-0">
				{job.finishedAt ? `Saved ${longTime(job.finishedAt)}. ` : "Saved. "}
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
