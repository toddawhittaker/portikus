import type {
	BackupRequestKind,
	BackupRequestView,
	BackupWorkspace,
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
	return utcText(new Date(stampIso(stamp)));
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

/**
 * A time on the Backups page, in UTC like the set names and restore folders,
 * so every time on the page is in the one zone it states.
 */
export function backupTime(iso: string): string {
	return utcText(new Date(iso));
}

function utcText(date: Date): string {
	const text = date.toLocaleString(undefined, {
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

export type NightKind = "complete" | "incomplete" | "failed" | "none" | "scheduled";

export interface Night {
	/** The UTC day, `2026-11-12`. */
	day: string;
	kind: NightKind;
}

const DAY_MS = 86_400_000;

/**
 * The last `count` nights, oldest first, ending on the night of the next
 * scheduled run when there is one: what each night left behind, from the
 * sets the host lists and its last failure.
 */
export function nights(
	host: {
		sets: readonly { stamp: string; complete: boolean }[];
		nextRunAt: string | null;
		lastFailure: { at: string } | null;
	},
	now: number,
	count = 14,
): Night[] {
	const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
	const next = host.nextRunAt ? Date.parse(host.nextRunAt) : null;
	// The strip ends on tonight's run when it is due within a day, else on today.
	const end = next !== null && next - now < 2 * DAY_MS && next >= now ? next : now;
	const byDay = new Map<string, boolean>();
	for (const set of host.sets) {
		const day = stampIso(set.stamp).slice(0, 10);
		byDay.set(day, (byDay.get(day) ?? false) || set.complete);
	}
	const failedDay = host.lastFailure ? dayOf(Date.parse(host.lastFailure.at)) : null;
	const scheduledDay = next !== null ? dayOf(next) : null;
	const out: Night[] = [];
	for (let i = count - 1; i >= 0; i--) {
		const day = dayOf(end - i * DAY_MS);
		const set = byDay.get(day);
		const kind: NightKind =
			set === true
				? "complete"
				: set === false
					? "incomplete"
					: day === failedDay
						? "failed"
						: day === scheduledDay
							? "scheduled"
							: "none";
		out.push({ day, kind });
	}
	return out;
}

/** "Thu, Nov 12" for a UTC day. */
export function nightLabel(day: string): string {
	return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});
}
