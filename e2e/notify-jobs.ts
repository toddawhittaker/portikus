import { execFile } from "node:child_process";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
 * NOTIFY_FILE and writes request files into ALERTS_JOBS_DIR, both under a
 * root prefix of their own, and `playAlertsJob` runs the real root alerts
 * job there unprivileged. Keyed by the API's port so two runs on one
 * machine never share it.
 */
const NOTIFY_ROOT = join(tmpdir(), `portikus-e2e-notify-${API_PORT}`);
export const NOTIFY_FILE = join(NOTIFY_ROOT, "etc/portikus/notify.json");
export const ALERTS_JOBS_DIR = join(NOTIFY_ROOT, "var/lib/portikus/alerts-jobs");

const ALERTS_JOB = fileURLToPath(
	new URL("../packaging/alerts/alerts-job", import.meta.url),
);

/**
 * Load the job as a module and run one pass, as its systemd unit does. A
 * forced refusal replaces its merge, and a forced failure its apply of a
 * request, so the job's own status writing still reports them.
 */
const RUN_JOB = `
import sys
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
path, root, refuse, fail = sys.argv[1:5]
loader = SourceFileLoader("alerts_job", path)
job = module_from_spec(spec_from_loader("alerts_job", loader))
loader.exec_module(job)
if refuse:
    def merge(update, stored):
        raise job.Refused(refuse)
    job.merge = merge
if fail:
    apply = job.Runner.apply
    def failing(self, settings, write_file=True):
        if write_file:
            raise job.JobFailed(fail)
        return apply(self, settings, write_file)
    job.Runner.apply = failing
sys.exit(job.Runner(root=root).run_pending())
`;

/** Write then rename, as the root job does, so the API never reads half a file. */
async function writeAtomic(path: string, text: string): Promise<void> {
	await writeFile(`${path}.tmp`, text);
	await rename(`${path}.tmp`, path);
}

/** No settings file and no jobs: every channel off, as on a new site. */
export async function resetNotifyStore(): Promise<void> {
	await rm(NOTIFY_ROOT, { recursive: true, force: true });
	await mkdir(dirname(NOTIFY_FILE), { recursive: true });
	await mkdir(ALERTS_JOBS_DIR, { recursive: true });
}

/** Put a settings file in force, as an earlier save or setup would have. */
export async function putNotifyFile(file: NotifyFile): Promise<void> {
	await mkdir(dirname(NOTIFY_FILE), { recursive: true });
	await writeAtomic(NOTIFY_FILE, `${JSON.stringify(file, null, 2)}\n`);
}

export async function readNotifyFile(): Promise<NotifyFile> {
	try {
		return JSON.parse(await readFile(NOTIFY_FILE, "utf8"));
	} catch {
		return NOTIFY_FILE_OFF;
	}
}

async function requestFiles(): Promise<string[]> {
	return (await readdir(ALERTS_JOBS_DIR)).filter((n) => /^request-.*\.json$/.test(n));
}

/**
 * A request the job never took, queued `minutes` ago, as after the job
 * unit died. Returns its path so the test can take it away again.
 */
export async function putStaleRequest(minutes: number): Promise<string> {
	const id = crypto.randomUUID();
	const path = join(ALERTS_JOBS_DIR, `request-${id}.json`);
	await writeFile(path, "{}", { mode: 0o600 });
	const then = new Date(Date.now() - minutes * 60_000);
	await utimes(path, then, then);
	return path;
}

/**
 * Run the root alerts job once, after the API's request file appears.
 * `refuse` or `fail` ends the job with that code and leaves the settings
 * alone. Returns the request, secrets and all, and the request file's mode,
 * read before the job deletes it.
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
			await mkdir(dirname(NOTIFY_FILE), { recursive: true });
			await promisify(execFile)("python3", [
				"-I",
				"-B",
				"-c",
				RUN_JOB,
				ALERTS_JOB,
				NOTIFY_ROOT,
				outcome.refuse ?? "",
				outcome.fail ?? "",
			]);
			return { id: request.id, mode, settings: request.settings };
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("the API wrote no request file");
}
