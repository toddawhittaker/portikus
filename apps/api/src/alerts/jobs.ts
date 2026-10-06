import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
	AlertChannelKind,
	isNotifyJobActive,
	type NotificationSettingsUpdate,
	type NotificationSettingsView,
	NotifyJobId,
	NotifyJobStatusFile,
	type NotifyJobView,
} from "@portikus/contracts";
import { listDir, readJson } from "../job-files.js";

/**
 * The API side of the root alerts job (ADR 0052): the API writes
 * `request-<id>.json` into ALERTS_JOBS_DIR and reads `<id>/status.json`
 * back. A request file may hold secrets, so its body is never read back.
 */

const REQUEST_FILE = /^request-([0-9a-f-]{36})\.json$/;

export function queuedView(id: string, requestedAt: string | null): NotifyJobView {
	return {
		id,
		state: "queued",
		code: null,
		channels: [],
		hosts: [],
		requestedAt,
		startedAt: null,
		finishedAt: null,
	};
}

async function queuedJobs(dir: string): Promise<NotifyJobView[]> {
	const jobs: NotifyJobView[] = [];
	for (const name of await listDir(dir)) {
		const id = REQUEST_FILE.exec(name)?.[1];
		if (!id || !NotifyJobId.safeParse(id).success) continue;
		// The file's age is its queue time; its body may hold secrets, so it is not read.
		const queuedAt = await stat(join(dir, name)).then(
			(s) => s.mtime.toISOString(),
			() => null,
		);
		jobs.push(queuedView(id, queuedAt));
	}
	return jobs;
}

/**
 * True while a job is queued or running and not yet stale. A job waiting
 * or running longer than NOTIFY_JOB_STALE_MS (the job unit's two-minute
 * TimeoutStartSec plus a margin) has died, and must not block later saves.
 */
export const isActive = isNotifyJobActive;

/**
 * The job the page should show: the newest by request or start time, with
 * a dead queued or running job ranked below every live or finished one, so
 * a job killed mid-run never hides the ones after it.
 */
export function latestJob(
	jobs: NotifyJobView[],
	now: number = Date.now(),
): NotifyJobView | null {
	const dead = (j: NotifyJobView) =>
		(j.state === "queued" || j.state === "running") && !isActive(j, now);
	const at = (j: NotifyJobView) => j.requestedAt ?? j.startedAt ?? "";
	const ranked = [...jobs].sort(
		(a, b) => Number(dead(a)) - Number(dead(b)) || at(b).localeCompare(at(a)),
	);
	return ranked[0] ?? null;
}

async function readJob(dir: string, id: string): Promise<NotifyJobView | null> {
	const status = await readJson(join(dir, id, "status.json"), NotifyJobStatusFile);
	if (!status || status.id !== id) return null;
	return {
		id,
		state: status.state,
		code: status.code,
		channels: status.channels,
		hosts: status.hosts,
		requestedAt: status.requestedAt,
		startedAt: status.startedAt,
		finishedAt: status.finishedAt,
	};
}

/** Every job the directory holds: requests still waiting, then those the job took. */
export async function allJobs(dir: string): Promise<NotifyJobView[]> {
	const jobs = await queuedJobs(dir);
	for (const name of await listDir(dir)) {
		if (!NotifyJobId.safeParse(name).success) continue;
		const job = await readJob(dir, name);
		if (job) jobs.push(job);
	}
	return jobs;
}

type Kind = "smtp" | keyof NotificationSettingsUpdate["alerts"];

function urlHost(url: string | undefined, kept: string | undefined): string | null {
	if (url !== undefined) return new URL(url).hostname;
	return kept ?? null;
}

/**
 * What an audit row may say about a change: the kinds that changed, the
 * kinds left on and their hosts. Never a secret (ADR 0052, SPEC.md 24.11).
 */
export function changeSummary(
	current: NotificationSettingsView,
	update: NotificationSettingsUpdate,
) {
	const { alerts } = update;
	const now = current.alerts;
	const onOff = (a: unknown, b: unknown) => (a === null) !== (b === null);
	const changed: Record<Kind, boolean> = {
		smtp:
			onOff(current.smtp, update.smtp) ||
			(update.smtp !== null &&
				(update.smtp.password !== undefined ||
					update.smtp.host !== current.smtp?.host ||
					update.smtp.port !== current.smtp?.port ||
					update.smtp.username !== current.smtp?.username ||
					update.smtp.from !== current.smtp?.from)),
		email:
			onOff(now.email, alerts.email) ||
			JSON.stringify(alerts.email?.to) !== JSON.stringify(now.email?.to),
		pushover:
			onOff(now.pushover, alerts.pushover) ||
			Object.keys(alerts.pushover ?? {}).length > 0,
		webhook: onOff(now.webhook, alerts.webhook) || alerts.webhook?.url !== undefined,
		ntfy: onOff(now.ntfy, alerts.ntfy) || Object.keys(alerts.ntfy ?? {}).length > 0,
		teams: onOff(now.teams, alerts.teams) || alerts.teams?.url !== undefined,
	};
	const hosts = [
		update.smtp?.host ?? null,
		alerts.webhook ? urlHost(alerts.webhook.url, now.webhook?.host) : null,
		alerts.ntfy ? urlHost(alerts.ntfy.url, now.ntfy?.host) : null,
		alerts.teams ? urlHost(alerts.teams.url, now.teams?.host) : null,
	].filter((h): h is string => h !== null);
	const on: Kind[] = [];
	if (update.smtp) on.push("smtp");
	for (const kind of ["email", "pushover", "webhook", "ntfy", "teams"] as const) {
		if (alerts[kind]) on.push(kind);
	}
	const rootShellOpenedAlertChanged =
		update.rootShellOpenedAlert !== current.rootShellOpenedAlert;
	const changedKinds: Array<Kind | "rootShellOpenedAlert"> = (
		Object.keys(changed) as Kind[]
	).filter((kind) => changed[kind]);
	if (rootShellOpenedAlertChanged) changedKinds.push("rootShellOpenedAlert");
	return {
		changed: changedKinds,
		channels: on,
		hosts: [...new Set(hosts)],
		rootShellOpenedAlert: update.rootShellOpenedAlert,
		rootShellOpenedAlertChanged,
	};
}

/**
 * The alert channels whose old target would miss a notice sent after the
 * change: those it turns off or re-targets. The worker reaches the rest
 * once the change is in force (ADR 0052). A changed SMTP server re-targets email.
 */
export function channelsLeaving(
	summary: ReturnType<typeof changeSummary>,
): AlertChannelKind[] {
	const kinds = AlertChannelKind.options.filter((kind) =>
		summary.changed.includes(kind),
	);
	if (summary.changed.includes("smtp") && !kinds.includes("email")) kinds.push("email");
	return kinds;
}
