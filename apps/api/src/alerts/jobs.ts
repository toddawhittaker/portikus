import { join } from "node:path";
import {
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
		if (id && NotifyJobId.safeParse(id).success) jobs.push(queuedView(id, null));
	}
	return jobs;
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
	return {
		changed: (Object.keys(changed) as Kind[]).filter((kind) => changed[kind]),
		channels: on,
		hosts: [...new Set(hosts)],
		rootShellOpenedAlert: update.rootShellOpenedAlert,
		rootShellOpenedAlertChanged:
			update.rootShellOpenedAlert !== current.rootShellOpenedAlert,
	};
}
