// Which process owns each listening socket inode, read from /proc (SPEC.md §18.2).
import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { ownedByStudent, parseStatusUids, readCommandLine } from "./processes.js";

/**
 * The lowest uid Debian gives a human account. Anything below it belongs to
 * the system: systemd-resolved, sshd and dnsmasq all sit there (SPEC.md §18.2).
 */
const FIRST_HUMAN_UID = 1000;

/** The process a socket inode belongs to. */
export interface SocketOwner {
	pid: number;
	/** `/proc/<pid>/comm`, the thread name. */
	command?: string;
	/**
	 * `/proc/<pid>/cmdline` with NULs turned into spaces, read only when the
	 * student owns the process (SPEC.md §24.11). Never logged.
	 */
	commandLine?: string;
}

/**
 * Whether a listener is the platform's own or a system account's rather than
 * the student's (SPEC.md §18.2).
 *
 * The agent itself is the process doing the scan, so a listener whose owning
 * pid is our own pid is the agent, whatever port it was configured with. The
 * uid rule catches systemd-resolved, sshd and dnsmasq. A port published by an
 * inner Docker container is the student's work even though `docker-proxy`
 * holds it as root, so a container attribution wins.
 *
 * The agent also opens a loopback forward on the student's own port to serve
 * a preview (BROWSER-HANDLING.md §11.1), which makes the agent one holder of
 * that port. A forward is never the service, so a forwarded port is judged by
 * the other rows alone.
 *
 * A port can have several rows, one per address family. It is hidden only
 * when every one of them belongs to a system account: one row that is the
 * student's makes the port the student's, because hiding it would hide their
 * own work.
 */
export function isSystemListener(input: {
	ownerPid?: number;
	uids: number[];
	hasContainer: boolean;
	selfPid?: number;
	isForwarded?: boolean;
}): boolean {
	if (input.hasContainer) return false;
	const selfPid = input.selfPid ?? process.pid;
	if (
		!input.isForwarded &&
		input.ownerPid !== undefined &&
		input.ownerPid === selfPid
	) {
		return true;
	}
	if (input.uids.length === 0) return false;
	return input.uids.every((uid) => uid >= 0 && uid < FIRST_HUMAN_UID);
}

/**
 * Map socket inodes to the process holding them, by walking `/proc/<pid>/fd`.
 * Directories and links we may not read are skipped. The command line is
 * read only for the student's own processes, the same test Monitor uses.
 */
export async function readSocketOwners(
	procRoot: string,
	studentUid: number,
): Promise<Map<string, SocketOwner>> {
	const owners = new Map<string, SocketOwner>();
	let entries: string[];
	try {
		entries = await readdir(procRoot);
	} catch {
		return owners;
	}
	for (const entry of entries) {
		const pid = Number.parseInt(entry, 10);
		if (!Number.isInteger(pid) || String(pid) !== entry) continue;
		await addProcessSockets(procRoot, entry, pid, studentUid, owners);
	}
	return owners;
}

/** Record the sockets one process holds, unless an earlier process holds them. */
async function addProcessSockets(
	procRoot: string,
	entry: string,
	pid: number,
	studentUid: number,
	owners: Map<string, SocketOwner>,
): Promise<void> {
	let descriptors: string[];
	try {
		descriptors = await readdir(join(procRoot, entry, "fd"));
	} catch {
		return;
	}
	let command: string | undefined;
	let commandLine: string | undefined;
	let commandRead = false;
	for (const descriptor of descriptors) {
		let target: string;
		try {
			target = await readlink(join(procRoot, entry, "fd", descriptor));
		} catch {
			continue;
		}
		const match = /^socket:\[(\d+)]$/.exec(target);
		if (!match) continue;
		if (!commandRead) {
			commandRead = true;
			command = await readComm(procRoot, entry);
			if (await isStudentProcess(procRoot, entry, studentUid)) {
				commandLine = (await readCommandLine(procRoot, pid)) ?? undefined;
			}
		}
		// The first process found for an inode wins; a forked child holding
		// the same socket tells the student nothing extra.
		const inode = match[1] ?? "";
		if (!owners.has(inode)) {
			owners.set(inode, {
				pid,
				command,
				...(commandLine !== undefined ? { commandLine } : {}),
			});
		}
	}
}

async function readComm(procRoot: string, pid: string): Promise<string | undefined> {
	try {
		const text = await readFile(join(procRoot, pid, "comm"), "utf8");
		const command = text.trim();
		return command === "" ? undefined : command;
	} catch {
		return undefined;
	}
}

/** Whether the student owns this process: its real and effective uid are theirs. */
async function isStudentProcess(
	procRoot: string,
	pid: string,
	studentUid: number,
): Promise<boolean> {
	let text: string;
	try {
		text = await readFile(join(procRoot, pid, "status"), "utf8");
	} catch {
		return false;
	}
	const uids = parseStatusUids(text);
	return uids !== null && ownedByStudent({ uids }, { studentUid });
}
