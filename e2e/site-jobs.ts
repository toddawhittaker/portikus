import { execFile } from "node:child_process";
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
	SiteJobKind,
	SiteJobRequest,
	SiteJobStatusFile,
} from "../packages/contracts/dist/site.js";
import { API_PORT } from "./ports";

/**
 * A fake host for the site pages (ADR 0059). The API writes request files
 * into SITE_JOBS_DIR and reads the view and page files, all under a root
 * prefix of their own, and `playSiteJob` runs the real root site job there
 * unprivileged, with the real write-settings and LTI platforms check. Squid,
 * systemd, debconf and setup are faked, and nothing writes the view until a
 * test does. Keyed by the API's port so two runs on one machine never share it.
 */
const SITE_ROOT = join(tmpdir(), `portikus-e2e-site-${API_PORT}`);
export const SITE_JOBS_DIR = join(SITE_ROOT, "var/lib/portikus/site-jobs");
export const SITE_VIEW_FILE = join(SITE_ROOT, "etc/portikus/site-view.json");
export const PROXY_HOSTS_FILE = join(SITE_ROOT, "etc/portikus/proxy-hosts.json");
export const LTI_ADMIN_PLATFORMS_FILE = join(
	SITE_ROOT,
	"etc/portikus/lti-platforms-admin.json",
);
const INSTALL_ANSWERS = join(SITE_ROOT, "etc/portikus/portikus.yaml");
/** Where the fake Squid configuration lives; the operator's hosts are read from it. */
export const SQUID_CONF = join(SITE_ROOT, "etc/squid/squid.conf");

const repo = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const SITE_JOB = repo("packaging/site/site-job");
const WRITE_SETTINGS = repo("packaging/site/write-settings");
const SETTINGS_KEYS = repo("packaging/debian/settings-keys");
const PLATFORMS_CHECK = repo("packages/auth/dist/lti/platforms-check-main.js");

/** How the faked host commands answer one run of the job. */
interface SiteJobOutcome {
	/** Setup fails once, so a trial is put back (`reverted`, `setup_failed`). */
	setupFails?: boolean;
	/** `squid -k parse` refuses the new include (`proxy_config_rejected`). */
	squidRejects?: boolean;
	/** The operator's platforms file the job checks for a clash; none by default. */
	operatorPlatformsFile?: string;
	/** Seconds added to the job's clock, so a trial's deadline can pass. */
	clockOffsetSeconds?: number;
}

/**
 * Load the job as a module and run one pass, as its systemd unit does, or
 * `expire <id>` as a trial's timer does. Only the platforms check runs for
 * real, with this Node.
 */
const RUN_JOB = `
import json, subprocess, sys, time
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
path, root, write_settings, keys, node, check, options, *expire = sys.argv[1:]
opts = json.loads(options)
loader = SourceFileLoader("site_job", path)
job = module_from_spec(spec_from_loader("site_job", loader))
loader.exec_module(job)
job.NODE, job.PLATFORMS_CHECK = node, check
setups = [1, 0] if opts.get("setupFails") else []
def fake(argv, timeout=60, stdin=None):
    if argv[0] == node:
        return subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True).returncode, ""
    if argv[0] == "squid":
        return (1 if opts.get("squidRejects") else 0), ""
    if argv[:3] == ["systemctl", "start", job.SETUP_UNIT]:
        return (setups.pop(0) if setups else 0), ""
    if argv[:4] == ["systemctl", "show", "-P", "ActiveState"]:
        return 0, "inactive\\n"
    if argv[0] in ("systemctl", "systemd-run", "debconf-set-selections", "journalctl"):
        return 0, ""
    raise SystemExit("unexpected command " + argv[0])
offset = opts.get("clockOffsetSeconds", 0)
runner = job.Runner(root=root, run_=fake, clock=lambda: time.time() + offset,
                    write_settings=write_settings, settings_keys=keys)
runner.lti_operator_file = opts.get("operatorPlatformsFile") or root + "/nonexistent"
sys.exit(runner.run_expire(expire[0]) if expire else runner.run_pending())
`;

function runJob(outcome: SiteJobOutcome, expire?: string): Promise<unknown> {
	const args = [
		"-I",
		"-B",
		"-c",
		RUN_JOB,
		SITE_JOB,
		SITE_ROOT,
		WRITE_SETTINGS,
		SETTINGS_KEYS,
		process.execPath,
		PLATFORMS_CHECK,
		JSON.stringify(outcome),
	];
	return promisify(execFile)("python3", expire ? [...args, expire] : args);
}

/** Write then rename, as setup does, so the API never reads half a file. */
async function writeAtomic(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(`${path}.tmp`, text);
	await rename(`${path}.tmp`, path);
}

/**
 * No jobs, page files, view or install answers: a development install,
 * where the address and sign-in settings are unavailable.
 */
export async function resetSiteStore(): Promise<void> {
	await rm(SITE_ROOT, { recursive: true, force: true });
	await mkdir(SITE_JOBS_DIR, { recursive: true });
	await mkdir(join(SITE_ROOT, "etc/portikus/egress-proxy.d"), { recursive: true });
	await writeAtomic(SQUID_CONF, "include /etc/portikus/egress-proxy.d/*.conf\n");
}

/**
 * The install answers dpkg-reconfigure would write, which make this an apt
 * install where address and sign-in jobs run. YAML, as in portikus.yaml.
 */
export async function putInstallAnswers(yaml: string): Promise<void> {
	await writeAtomic(INSTALL_ANSWERS, yaml);
}

export async function readInstallAnswers(): Promise<string> {
	return readFile(INSTALL_ANSWERS, "utf8");
}

/** A job's status file as the job wrote it, or null before it took the request. */
export async function readSiteStatus(id: string): Promise<SiteJobStatusFile | null> {
	try {
		return JSON.parse(
			await readFile(join(SITE_JOBS_DIR, "status", `${id}.json`), "utf8"),
		);
	} catch {
		return null;
	}
}

async function requestFiles(): Promise<string[]> {
	return (await readdir(SITE_JOBS_DIR)).filter((n) => /^request-.*\.json$/.test(n));
}

/**
 * Run the root site job once, after the API's request file appears. Returns
 * the request, a signin's client secret and all, and the request file's
 * mode, read before the job deletes it.
 */
export async function playSiteJob(
	outcome: SiteJobOutcome = {},
): Promise<{ id: string; kind: SiteJobKind; mode: number; request: SiteJobRequest }> {
	for (let tries = 0; tries < 100; tries++) {
		const name = (await requestFiles())[0];
		if (name) {
			const path = join(SITE_JOBS_DIR, name);
			const mode = (await stat(path)).mode & 0o777;
			const request = JSON.parse(await readFile(path, "utf8")) as SiteJobRequest;
			await runJob(outcome);
			return { id: request.id, kind: request.kind, mode, request };
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("the API wrote no site job request");
}

/** Run a trial's deadline, as its timer does; a clock past the deadline puts the trial back. */
export async function expireSiteTrial(
	id: string,
	outcome: SiteJobOutcome = { clockOffsetSeconds: 3600 },
): Promise<void> {
	await runJob(outcome, id);
}
