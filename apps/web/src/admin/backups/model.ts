import type {
	BackupRequestKind,
	BackupRequestView,
	BackupWorkspace,
	HostBackupSet,
} from "@portikus/contracts";

/** `20260924T023000Z` as an ISO time, `2026-09-24T02:30:00Z`. */
export function stampIso(stamp: string): string {
	return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
}

/** A time with its year, since sets and kept homes can be months old. */
export function longTime(iso: string): string {
	return new Date(iso).toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** A set's time in UTC, as its name, its restore folder and the student's notice give it. */
export function setTime(stamp: string): string {
	const text = new Date(stampIso(stamp)).toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZone: "UTC",
	});
	return `${text} UTC`;
}

/** The set the host refuses to delete: stamps sort by time. */
export function newestCompleteStamp(sets: HostBackupSet[]): string | null {
	return (
		sets
			.filter((set) => set.complete)
			.map((set) => set.stamp)
			.sort()
			.at(-1) ?? null
	);
}

export function isWaiting(request: BackupRequestView): boolean {
	return request.state === "pending" || request.state === "claimed";
}

/** The waiting request of this kind whose arguments include `args`, if any. */
export function waitingRequest(
	requests: BackupRequestView[],
	kind: BackupRequestKind,
	args: Record<string, string> = {},
): BackupRequestView | undefined {
	return requests.find(
		(request) =>
			request.kind === kind &&
			isWaiting(request) &&
			Object.entries(args).every(([key, value]) => request.args[key] === value),
	);
}

/** "Alice Smith (ws-1a2b3c4d)", or the instance name for a workspace the page cannot name. */
export function workspaceName(
	instance: string | undefined,
	workspaces: BackupWorkspace[],
): string {
	const ws = workspaces.find((w) => w.instance === instance);
	if (!ws) return instance ?? "Unknown workspace";
	return ws.label ? `${ws.ownerName} (${ws.label})` : ws.ownerName;
}

/** One line saying what a request asked for. */
export function requestText(
	request: BackupRequestView,
	workspaces: BackupWorkspace[],
): string {
	const { args } = request;
	const from = args.stamp ? ` from ${setTime(args.stamp)}` : "";
	switch (request.kind) {
		case "backup":
			return "Back up now";
		case "delete_set":
			return `Delete the set${from}`;
		case "delete_dump":
			return `Delete dump ${args.file}`;
		case "restore_copy":
			return `Restore ${workspaceName(args.instance, workspaces)}${from} into ~/${args.dir}`;
		case "import_home":
			return `Import the home of ${workspaceName(args.instance, workspaces)}${from}`;
		case "delete_snapshot":
			return `Delete snapshot ${args.snapshot} of ${args.volume}`;
		case "delete_kept_home":
			return `Delete kept home ${args.volume}`;
	}
}

/** Snapshot and kept-home deletes run in the VM; everything else on the host. */
function runner(kind: BackupRequestKind): string {
	return kind === "delete_snapshot" || kind === "delete_kept_home"
		? "the platform"
		: "the host";
}

export function stateText(request: BackupRequestView): string {
	switch (request.state) {
		case "pending":
			return `Waiting for ${runner(request.kind)}`;
		case "claimed":
			return "Running";
		case "done":
			return "Done";
		case "failed":
			return "Failed";
	}
}

/** What the host is doing now, in words. */
export function runningText(
	running: string | null,
	requests: BackupRequestView[],
	workspaces: BackupWorkspace[],
): string {
	if (running === null) return "Nothing";
	if (running === "nightly") return "The nightly backup";
	const request = requests.find((r) => r.id === running);
	return request ? requestText(request, workspaces) : "A requested job";
}
