import { execFile } from "node:child_process";
import { constants as fsc } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readFile,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { EgressApplyPolicy } from "@portikus/contracts";
import { BRIDGE_RE, type EgressEnv, overlapsDenied, parseEgressEnv } from "./env.js";
import {
	EGRESS_DNS_UNIT,
	EGRESS_PATHS,
	STATE_FILES,
	WORKSPACE_PROXY_UNIT,
} from "./paths.js";
import {
	renderDnsmasq,
	renderDropAll,
	renderSquidBlocked,
	renderSquidNames,
	renderSquidOpen,
	renderTable,
	usesOurResolver,
} from "./render.js";

/**
 * The root helper (ADR 0038, the pattern of ADR 0030). systemd starts it
 * when the controller writes a request, and once at boot. It trusts
 * nothing the controller wrote: the request is moved aside, read without
 * following links, capped in size and checked strictly before any value
 * reaches the firewall or a configuration file.
 */

export interface RunResult {
	code: number;
	stderr: string;
}

/** Runs one fixed program with arguments and optional standard input. */
export type Runner = (
	file: string,
	args: string[],
	input?: string,
) => Promise<RunResult>;

export interface HelperDeps {
	run: Runner;
	requestPath: string;
	stateDir: string;
	envPath: string;
	now: () => Date;
	/** Skip the root-ownership checks on the configuration file (tests only). */
	allowAnyOwner?: boolean;
}

/** What the helper records after each request; the controller waits for it. */
export interface HelperStatus {
	requestId: string | null;
	version: number | null;
	ok: boolean;
	error: string | null;
	at: string;
}

/** The last policy that applied fully; reloaded at boot. */
export interface AppliedFile {
	policy: EgressApplyPolicy;
	appliedAt: string;
	/** Recorded so a boot with an unusable egress.env can still drop on this bridge. */
	bridge?: string;
	gateway?: string;
}

const NFT = "/usr/sbin/nft";
const SYSTEMCTL = "/usr/bin/systemctl";
const CONNTRACK = "/usr/sbin/conntrack";
/** The bridge the Incus network role creates; the fallback when applied.json cannot say. */
const DEFAULT_BRIDGE = "portikus-ws";

/** Largest request accepted: 600 names of 253 characters with JSON overhead. */
export const MAX_REQUEST_BYTES = 256 * 1024;

const RequestId = /^[A-Za-z0-9-]{1,64}$/;

export function defaultRunner(): Runner {
	return (file, args, input) =>
		new Promise((resolve) => {
			const child = execFile(file, args, { timeout: 60_000 }, (err, _out, stderr) => {
				const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
				resolve({ code, stderr: String(stderr).slice(0, 500) });
			});
			// A command may exit before reading its input (nft list at boot); EPIPE
			// is then expected, and unhandled it would crash the helper.
			child.stdin?.on("error", () => undefined);
			child.stdin?.end(input ?? "");
		});
}

export function defaultDeps(): HelperDeps {
	return {
		run: defaultRunner(),
		requestPath: EGRESS_PATHS.request,
		stateDir: EGRESS_PATHS.stateDir,
		envPath: EGRESS_PATHS.env,
		now: () => new Date(),
	};
}

/** Read the root-owned configuration, refusing a link or a file others could write. */
async function readEnv(deps: HelperDeps): Promise<EgressEnv> {
	const st = await lstat(deps.envPath);
	if (!st.isFile()) throw new Error("egress.env is not a regular file");
	if (!deps.allowAnyOwner && (st.uid !== 0 || (st.mode & 0o022) !== 0)) {
		throw new Error("egress.env must be owned by root and writable only by root");
	}
	return parseEgressEnv(await readFile(deps.envPath, "utf8"));
}

async function writeState(
	deps: HelperDeps,
	name: string,
	content: string,
): Promise<void> {
	const final = join(deps.stateDir, name);
	const tmp = `${final}.tmp`;
	// Everything in the state directory is world-readable: names and addresses of listed hosts only.
	await writeFile(tmp, content, { mode: 0o644 });
	await rename(tmp, final);
}

async function readApplied(deps: HelperDeps): Promise<AppliedFile | null> {
	let text: string;
	try {
		text = await readFile(join(deps.stateDir, STATE_FILES.applied), "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
	const parsed = JSON.parse(text) as {
		policy?: unknown;
		appliedAt?: unknown;
		bridge?: unknown;
		gateway?: unknown;
	};
	const policy = EgressApplyPolicy.parse(parsed.policy);
	if (typeof parsed.appliedAt !== "string") throw new Error("applied.json has no time");
	const applied: AppliedFile = { policy, appliedAt: parsed.appliedAt };
	if (typeof parsed.bridge === "string") applied.bridge = parsed.bridge;
	if (typeof parsed.gateway === "string") applied.gateway = parsed.gateway;
	return applied;
}

async function readLastStatusOk(deps: HelperDeps): Promise<boolean> {
	try {
		const s = JSON.parse(
			await readFile(join(deps.stateDir, STATE_FILES.status), "utf8"),
		) as { ok?: unknown };
		return s.ok === true;
	} catch {
		return false;
	}
}

/**
 * Take the request out of the controller's directory into our own, then
 * read it through a descriptor opened without following links, as a
 * single-link regular file under the size cap. Returns null when there is
 * no request.
 */
async function takeRequest(deps: HelperDeps): Promise<string | null> {
	const aside = join(deps.stateDir, STATE_FILES.processing);
	// A leftover from a crash, even a directory, would make every rename fail.
	await rm(aside, { recursive: true, force: true });
	try {
		await rename(deps.requestPath, aside);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
	try {
		const fh = await open(aside, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
		try {
			const st = await fh.stat();
			if (!st.isFile() || st.nlink !== 1) throw new RefusedError("not a regular file");
			if (st.size > MAX_REQUEST_BYTES) throw new RefusedError("too large");
			return await fh.readFile("utf8");
		} finally {
			await fh.close();
		}
	} catch (e) {
		if (e instanceof RefusedError) throw e;
		// A link (ELOOP) or anything else odd: refuse, and never echo what it pointed at.
		throw new RefusedError("could not be read as a plain file");
	} finally {
		await unlink(aside).catch(() => undefined);
	}
}

class RefusedError extends Error {}

/** The request's id when it has a well-formed one, so a refusal can answer that request. */
function requestIdOf(text: string): string | null {
	try {
		const id = (JSON.parse(text) as { requestId?: unknown }).requestId;
		return typeof id === "string" && RequestId.test(id) ? id : null;
	} catch {
		return null;
	}
}

/** Parse and check a request's text. Messages never quote the request itself. */
export function parseRequest(
	text: string,
	env: EgressEnv,
): { requestId: string; policy: EgressApplyPolicy } {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new RefusedError("not JSON");
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new RefusedError("not an object");
	}
	const { requestId, ...rest } = raw as Record<string, unknown>;
	if (typeof requestId !== "string" || !RequestId.test(requestId)) {
		throw new RefusedError("bad request id");
	}
	const parsed = EgressApplyPolicy.safeParse(rest);
	if (!parsed.success) {
		const fields = [
			...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "body"))),
		];
		throw new RefusedError(`invalid ${fields.join(", ")}`);
	}
	if (parsed.data.ranges.some((r) => overlapsDenied(env, r))) {
		throw new RefusedError("a range overlaps a denied range");
	}
	return { requestId, policy: parsed.data };
}

async function loadTable(deps: HelperDeps, script: string): Promise<void> {
	const r = await deps.run(NFT, ["-f", "-"], script);
	if (r.code !== 0) throw new Error(`nft refused the table: ${r.stderr.trim()}`);
}

async function systemctl(
	deps: HelperDeps,
	verb: "reload" | "restart" | "stop",
	unit: typeof EGRESS_DNS_UNIT | typeof WORKSPACE_PROXY_UNIT,
	noBlock = false,
): Promise<void> {
	const args = noBlock ? [verb, "--no-block", unit] : [verb, unit];
	const r = await deps.run(SYSTEMCTL, args);
	if (r.code !== 0)
		throw new Error(`systemctl ${verb} ${unit} failed: ${r.stderr.trim()}`);
}

function namesRemoved(
	before: EgressApplyPolicy | undefined,
	after: EgressApplyPolicy,
): boolean {
	if (!before || before.mode !== after.mode) return true;
	const kept = new Set(after.names);
	return before.names.some((n) => !kept.has(n));
}

function blockedChanged(
	before: EgressApplyPolicy | undefined,
	after: EgressApplyPolicy,
): boolean {
	return (before?.blocked ?? []).join("\n") !== after.blocked.join("\n");
}

/** Delete the conntrack entries of web connections from the workspace subnet, the ones the table redirects. */
async function forgetConnections(deps: HelperDeps, env: EgressEnv): Promise<void> {
	for (const port of ["80", "443"]) {
		const r = await deps.run(CONNTRACK, [
			"-D",
			"-s",
			env.subnet,
			"-p",
			"tcp",
			"--dport",
			port,
		]);
		// It exits 1 when nothing matched; its summary line says whether it ran.
		if (r.code !== 0 && !/flow entries have been deleted/.test(r.stderr)) {
			throw new Error(`conntrack failed: ${r.stderr.trim()}`);
		}
	}
}

async function writeSquidLists(
	deps: HelperDeps,
	policy: EgressApplyPolicy,
): Promise<void> {
	await writeState(deps, STATE_FILES.names, renderSquidNames(policy));
	await writeState(deps, STATE_FILES.blocked, renderSquidBlocked(policy));
	await writeState(deps, STATE_FILES.open, renderSquidOpen(policy));
}

/**
 * Apply a checked policy in the order that fails closed (ADR 0038): the
 * table, then dnsmasq, then Squid's list. A step that fails stops the rest
 * and leaves applied.json as it was, so the worker retries. At boot the
 * services are only queued: our dnsmasq starts after Incus, which waits for
 * this run, so waiting for it would hang until the start timeout.
 *
 * Going from plain open mode to open mode with blocked sites, the services
 * come first (ADR 0043): nothing reaches them until the table redirects, and
 * a Squid still on the empty lists would refuse, and count, every name.
 */
async function applyPolicy(
	deps: HelperDeps,
	env: EgressEnv,
	policy: EgressApplyPolicy,
	previous: AppliedFile | null,
	boot: boolean,
): Promise<void> {
	// A failed earlier request may have loaded names applied.json does not know; flush then too.
	const flush =
		namesRemoved(previous?.policy, policy) || !(await readLastStatusOk(deps));
	const servicesFirst =
		policy.mode === "open" &&
		policy.blocked.length > 0 &&
		!(previous && usesOurResolver(previous.policy));
	if (!servicesFirst) await loadTable(deps, renderTable(policy, env, flush));

	await writeState(deps, STATE_FILES.dnsmasq, renderDnsmasq(policy, env));
	if (usesOurResolver(policy)) await systemctl(deps, "restart", EGRESS_DNS_UNIT, boot);
	else await systemctl(deps, "stop", EGRESS_DNS_UNIT, boot);

	await writeSquidLists(deps, policy);
	await systemctl(deps, "reload", WORKSPACE_PROXY_UNIT, boot);

	if (servicesFirst) await loadTable(deps, renderTable(policy, env, flush));
	// NAT is decided when a connection starts; forget open ones so a new block covers them too.
	if (blockedChanged(previous?.policy, policy)) await forgetConnections(deps, env);

	const applied: AppliedFile = {
		policy,
		appliedAt: deps.now().toISOString(),
		bridge: env.bridge,
		gateway: env.gateway,
	};
	await writeState(deps, STATE_FILES.applied, `${JSON.stringify(applied)}\n`);
}

/**
 * When the table is missing (after a reboot), load the last applied policy
 * and rewrite its files. Services are only queued (`--no-block`), because
 * this runs before Incus has made the bridge. If the last policy was an
 * allow-list, or applied.json is unreadable, and loading fails, forwarding
 * from the bridge is dropped instead.
 */
async function restoreAtBoot(deps: HelperDeps, env: EgressEnv): Promise<void> {
	let applied: AppliedFile | null;
	try {
		applied = await readApplied(deps);
	} catch {
		await loadTable(deps, renderDropAll(env));
		throw new Error("applied.json could not be read; workspace forwarding is dropped");
	}
	if (!applied) return; // Never applied: open mode, as a fresh site has always been.
	const { policy } = applied;
	try {
		await loadTable(deps, renderTable(policy, env, true));
	} catch (e) {
		if (usesOurResolver(policy)) {
			await loadTable(deps, renderDropAll(env));
			throw new Error(
				`${(e as Error).message}; workspace forwarding is dropped until a policy applies`,
			);
		}
		throw e;
	}
	await writeState(deps, STATE_FILES.dnsmasq, renderDnsmasq(policy, env));
	await writeSquidLists(deps, policy);
	if (usesOurResolver(policy)) {
		await systemctl(deps, "restart", EGRESS_DNS_UNIT, true);
	}
}

/**
 * With egress.env unusable, a missing table after an allow-list would leave
 * workspaces open. Drop forwarding on the bridge applied.json recorded, or
 * on the default bridge when applied.json is unreadable or names no usable
 * bridge. A site that never applied (no applied.json) loads nothing.
 * Returns a message when it dropped, null when it did nothing.
 */
async function dropWithoutEnv(deps: HelperDeps): Promise<string | null> {
	let applied: AppliedFile | null = null;
	let unreadable = false;
	try {
		applied = await readApplied(deps);
	} catch {
		unreadable = true;
	}
	if (!unreadable && !(applied && usesOurResolver(applied.policy))) return null;
	const recorded = applied?.bridge;
	const bridge =
		recorded !== undefined && BRIDGE_RE.test(recorded) ? recorded : DEFAULT_BRIDGE;
	if (await tableLoaded(deps)) return null;
	await loadTable(deps, renderDropAll({ bridge }));
	return "workspace forwarding is dropped until egress.env is fixed";
}

async function tableLoaded(deps: HelperDeps): Promise<boolean> {
	const r = await deps.run(NFT, ["list", "table", "inet", "portikus_egress"]);
	return r.code === 0;
}

/** One run of the helper. Returns the process exit code. */
export async function runHelper(deps: HelperDeps): Promise<number> {
	await mkdir(deps.stateDir, { recursive: true, mode: 0o755 });
	const status = async (s: Omit<HelperStatus, "at">): Promise<void> => {
		const full: HelperStatus = { ...s, at: deps.now().toISOString() };
		await writeState(deps, STATE_FILES.status, `${JSON.stringify(full)}\n`);
	};

	let env: EgressEnv;
	try {
		env = await readEnv(deps);
	} catch (e) {
		await takeRequest(deps).catch(() => null);
		const dropped = await dropWithoutEnv(deps).catch(() => null);
		await status({
			requestId: null,
			version: null,
			ok: false,
			error: dropped ? `${(e as Error).message}; ${dropped}` : (e as Error).message,
		});
		return 1;
	}

	// Take the request before anything can fail, so a failed run never leaves
	// it behind for the path unit to start this run again at once.
	let text: string | null = null;
	let takeError: Error | null = null;
	try {
		text = await takeRequest(deps);
	} catch (e) {
		takeError = e as Error;
	}

	const boot = !(await tableLoaded(deps));
	if (boot) {
		try {
			await restoreAtBoot(deps, env);
		} catch (e) {
			await status({
				requestId: text === null ? null : requestIdOf(text),
				version: null,
				ok: false,
				error: (e as Error).message,
			});
			return 1;
		}
	}

	if (takeError) {
		await status({
			requestId: null,
			version: null,
			ok: false,
			error: `request refused: ${takeError.message}`,
		});
		return 1;
	}
	if (text === null) return 0;

	let request: { requestId: string; policy: EgressApplyPolicy };
	try {
		request = parseRequest(text, env);
	} catch (e) {
		await status({
			requestId: requestIdOf(text),
			version: null,
			ok: false,
			error: `request refused: ${(e as Error).message}`,
		});
		return 1;
	}

	const { requestId, policy } = request;
	try {
		const previous = await readApplied(deps).catch(() => null);
		await applyPolicy(deps, env, policy, previous, boot);
	} catch (e) {
		await status({
			requestId,
			version: policy.version,
			ok: false,
			error: (e as Error).message,
		});
		return 1;
	}
	await status({ requestId, version: policy.version, ok: true, error: null });
	return 0;
}
