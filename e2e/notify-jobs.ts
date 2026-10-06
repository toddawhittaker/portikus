import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	NOTIFY_FILE_OFF,
	type NotificationSettingsUpdate,
	type NotifyFile,
	type NotifyJobCode,
} from "../packages/contracts/dist/notify.js";
import { API_PORT } from "./ports";

export type { NotifyFile };

/**
 * A fake host for the Notifications section (ADR 0052). The API reads
 * NOTIFY_FILE and writes request files into ALERTS_JOBS_DIR; the tests play
 * the root alerts job with `playAlertsJob`. Keyed by the API's port so two
 * runs on one machine never share it.
 */
const NOTIFY_ROOT = join(tmpdir(), `portikus-e2e-notify-${API_PORT}`);
export const NOTIFY_FILE = join(NOTIFY_ROOT, "notify.json");
export const ALERTS_JOBS_DIR = join(NOTIFY_ROOT, "alerts-jobs");

/** Write then rename, as the root job does, so the API never reads half a file. */
async function writeAtomic(path: string, text: string): Promise<void> {
	await writeFile(`${path}.tmp`, text);
	await rename(`${path}.tmp`, path);
}

/** No settings file and no jobs: every channel off, as on a new site. */
export async function resetNotifyStore(): Promise<void> {
	await rm(NOTIFY_FILE, { force: true });
	await rm(ALERTS_JOBS_DIR, { recursive: true, force: true });
	await mkdir(ALERTS_JOBS_DIR, { recursive: true });
}

/** Put a settings file in force, as an earlier save or setup would have. */
export async function putNotifyFile(file: NotifyFile): Promise<void> {
	await writeAtomic(NOTIFY_FILE, `${JSON.stringify(file, null, 2)}\n`);
}

export async function readNotifyFile(): Promise<NotifyFile> {
	try {
		return JSON.parse(await readFile(NOTIFY_FILE, "utf8"));
	} catch {
		return NOTIFY_FILE_OFF;
	}
}

class Refused extends Error {
	constructor(readonly code: NotifyJobCode) {
		super(code);
	}
}

const hostOf = (url: string) => new URL(url).hostname;

/**
 * The file an update asks for, as the root job's `merge` builds it: a
 * secret left out keeps the stored one, except that a new SMTP host, port
 * or user name clears the password and a new ntfy host clears the token.
 */
function merge(update: NotificationSettingsUpdate, stored: NotifyFile): NotifyFile {
	const old = stored.alerts;
	const kept = <T>(given: T | undefined, before: T | undefined): T => {
		if (given !== undefined) return given;
		if (before === undefined) throw new Refused("missing_secret");
		return before;
	};
	let smtp: NotifyFile["smtp"] = null;
	if (update.smtp) {
		const before = stored.smtp;
		const same =
			before !== null &&
			before.host.toLowerCase() === update.smtp.host.toLowerCase() &&
			before.port === update.smtp.port &&
			before.username === update.smtp.username;
		smtp = {
			...update.smtp,
			password: update.smtp.password ?? (same ? before.password : ""),
		};
	}
	const { pushover, webhook, ntfy, teams, email } = update.alerts;
	if (email && !smtp) throw new Refused("email_needs_smtp");
	let ntfyFile: NotifyFile["alerts"]["ntfy"] = null;
	if (ntfy) {
		const url = kept(ntfy.url, old.ntfy?.url);
		const sameHost = old.ntfy !== null && hostOf(old.ntfy.url) === hostOf(url);
		ntfyFile = { url, token: ntfy.token ?? (sameHost ? (old.ntfy?.token ?? "") : "") };
	}
	return {
		version: 1,
		smtp,
		alerts: {
			email,
			pushover: pushover && {
				userKey: kept(pushover.userKey, old.pushover?.userKey),
				appToken: kept(pushover.appToken, old.pushover?.appToken),
			},
			webhook: webhook && { url: kept(webhook.url, old.webhook?.url) },
			ntfy: ntfyFile,
			teams: teams && { url: kept(teams.url, old.teams?.url) },
		},
		rootShellOpenedAlert: update.rootShellOpenedAlert,
	};
}

async function requestFiles(): Promise<string[]> {
	return (await readdir(ALERTS_JOBS_DIR)).filter((n) => /^request-.*\.json$/.test(n));
}

/** Whether a request is still waiting for the job. */
export async function requestWaiting(): Promise<boolean> {
	return (await requestFiles()).length > 0;
}

/**
 * Play the root alerts job once: wait for the API's request file and delete
 * it first, as the job does, then write the settings file and the status.
 * `refuse` or `fail` ends the job with that code and leaves the file alone.
 * Returns the request, secrets and all, and the request file's mode.
 */
export async function playAlertsJob(
	outcome: { refuse?: NotifyJobCode; fail?: NotifyJobCode } = {},
): Promise<{ id: string; mode: number; settings: NotificationSettingsUpdate }> {
	for (let tries = 0; tries < 100; tries++) {
		const name = (await requestFiles())[0];
		if (name) {
			const path = join(ALERTS_JOBS_DIR, name);
			const mode = (await stat(path)).mode & 0o777;
			const request = JSON.parse(await readFile(path, "utf8"));
			await rm(path);
			const startedAt = new Date().toISOString();
			const record = {
				id: request.id,
				state: "running",
				code: null as NotifyJobCode | null,
				channels: [] as string[],
				hosts: [] as string[],
				requestedAt: request.requestedAt,
				requestedBy: request.requestedBy,
				startedAt,
				finishedAt: null as string | null,
			};
			try {
				if (outcome.refuse) throw new Refused(outcome.refuse);
				const file = merge(request.settings, await readNotifyFile());
				record.channels = Object.entries(file.alerts)
					.filter(([, block]) => block !== null)
					.map(([kind]) => kind);
				record.hosts = [
					...(file.smtp ? [file.smtp.host] : []),
					...(file.alerts.pushover ? ["api.pushover.net"] : []),
					...[file.alerts.webhook, file.alerts.ntfy, file.alerts.teams].flatMap((b) =>
						b ? [hostOf(b.url)] : [],
					),
				].sort();
				if (outcome.fail) {
					record.state = "failed";
					record.code = outcome.fail;
				} else {
					await putNotifyFile(file);
					record.state = "succeeded";
				}
			} catch (error) {
				if (!(error instanceof Refused)) throw error;
				record.state = "refused";
				record.code = error.code;
			}
			record.finishedAt = new Date().toISOString();
			await mkdir(join(ALERTS_JOBS_DIR, request.id), { recursive: true });
			await writeAtomic(
				join(ALERTS_JOBS_DIR, request.id, "status.json"),
				JSON.stringify(record),
			);
			return { id: request.id, mode, settings: request.settings };
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("the API wrote no request file");
}
