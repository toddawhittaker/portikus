import {
	fetchNrpsMembers,
	NrpsError,
	type NrpsMember,
	requestNrpsToken,
} from "@portikus/auth";
import type {
	CourseRoster,
	RosterSyncResponse,
	RosterSyncResult,
} from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import type { FastifyBaseLogger } from "fastify";
import type { Kysely, Transaction } from "kysely";
import type { LtiDeps } from "../lti/deps.js";
import { toolJwks } from "../routes/lti.js";

/** NRPS may leave a name out; the Course page still needs something to show. */
export const UNNAMED_MEMBER = "Name not shared";

/** The course columns roster sync reads. */
export interface RosterCourse {
	id: string;
	platform_issuer: string;
	platform_client_id: string | null;
	nrps_url: string | null;
	roster_synced_at: Date | null;
	roster_sync_result: string | null;
}

export interface RosterDeps {
	db: Kysely<Database>;
	lti: LtiDeps | undefined;
	/** The egress proxy every outbound request goes through (ADR 0027). */
	proxyUrl: string | null;
	log: FastifyBaseLogger;
}

interface RosterSource {
	tokenUrl: string;
	clientId: string;
	membershipsUrl: string;
	toolKeyPem: string;
}

type Counts = Omit<RosterSyncResponse, "roster">;

// One API process serves every request, so a map in memory is enough to
// keep a second sync of the same course from starting (ADR 0058).
const inFlight = new Map<string, Promise<RosterSyncResponse>>();

const NO_CHANGES: Counts = { matched: 0, notStarted: 0, removed: 0, roleChanged: 0 };

export function selectRosterCourse(db: Kysely<Database>, courseId: string) {
	return db
		.selectFrom("lti_contexts")
		.select([
			"id",
			"platform_issuer",
			"platform_client_id",
			"nrps_url",
			"roster_synced_at",
			"roster_sync_result",
		])
		.where("id", "=", courseId);
}

/**
 * What a sync of this course needs, or null when sync is unavailable: no
 * tool key, no launch has stored the client id and memberships URL yet, or
 * the platform has no token URL (ADR 0058).
 */
function rosterSource(
	lti: LtiDeps | undefined,
	course: RosterCourse,
): RosterSource | null {
	if (!lti?.toolKeyPem || !course.nrps_url || !course.platform_client_id) return null;
	const platform = lti.platforms.find(
		(p) =>
			p.issuer === course.platform_issuer && p.clientId === course.platform_client_id,
	);
	if (!platform?.authTokenUrl) return null;
	return {
		tokenUrl: platform.authTokenUrl,
		clientId: course.platform_client_id,
		membershipsUrl: course.nrps_url,
		toolKeyPem: lti.toolKeyPem,
	};
}

export function courseRoster(
	lti: LtiDeps | undefined,
	course: RosterCourse,
): CourseRoster {
	return {
		available: rosterSource(lti, course) !== null,
		syncedAt: course.roster_synced_at
			? new Date(course.roster_synced_at).toISOString()
			: null,
		result: (course.roster_sync_result as RosterSyncResult | null) ?? null,
	};
}

/** One membership and the LTI subjects that identify it at the course's platform. */
export interface MembershipSubjects {
	userId: string;
	role: string;
	subjects: string[];
}

/**
 * A membership's subject is its user's own when the user is a course
 * account of this platform, or the linked course account's (ADR 0026).
 */
export async function membershipSubjects(
	db: Kysely<Database>,
	courseId: string,
	platformIssuer: string,
): Promise<MembershipSubjects[]> {
	const ltiIssuer = `lti:${platformIssuer}`;
	const rows = await db
		.selectFrom("lti_memberships as m")
		.innerJoin("users as u", "u.id", "m.user_id")
		.leftJoin("account_links as al", (join) =>
			join
				.onRef("al.user_id", "=", "m.user_id")
				.on("al.platform_issuer", "=", platformIssuer),
		)
		.leftJoin("users as cu", (join) =>
			join
				.onRef("cu.id", "=", "al.course_user_id")
				.on("cu.oidc_issuer", "=", ltiIssuer),
		)
		.select([
			"m.user_id",
			"m.role",
			"u.oidc_issuer",
			"u.oidc_subject",
			"cu.oidc_subject as linked_subject",
		])
		.where("m.context_id", "=", courseId)
		.execute();
	return rows.map((row) => {
		const subjects: string[] = [];
		if (row.oidc_issuer === ltiIssuer) subjects.push(row.oidc_subject);
		if (row.linked_subject !== null) subjects.push(row.linked_subject);
		return { userId: row.user_id, role: row.role, subjects };
	});
}

/** Which result a failed fetch records; no detail of the LMS's answer is kept. */
function failureResult(error: unknown): RosterSyncResult {
	if (!(error instanceof NrpsError)) return "fetch_failed";
	if (error.kind === "token_failed") return "token_failed";
	if (error.kind === "http_error") return "fetch_failed";
	return "invalid";
}

/**
 * Apply an active, non-empty roster in one transaction (ADR 0058): delete
 * every membership whose subject is gone, instructors too; set each kept
 * membership's course role; replace the not-started rows. Accounts, their
 * roles and workspaces are never touched (ADR 0025). A roster that would
 * leave no launched instructor is refused before anything is written, so
 * one bad LMS answer cannot lock every instructor out of the course.
 */
async function applyRoster(
	trx: Transaction<Database>,
	course: RosterCourse,
	active: NrpsMember[],
	actor: string,
	now: string,
): Promise<Counts | "no_instructor"> {
	const roster = new Map(active.map((member) => [member.userId, member]));
	const memberships = await membershipSubjects(trx, course.id, course.platform_issuer);
	const onRoster = new Set<string>();
	const gone: string[] = [];
	const kept: { userId: string; role: string; newRole: NrpsMember["role"] }[] = [];
	for (const membership of memberships) {
		const entry = membership.subjects
			.map((subject) => roster.get(subject))
			.find((member) => member !== undefined);
		if (!entry) {
			gone.push(membership.userId);
			continue;
		}
		for (const subject of membership.subjects) onRoster.add(subject);
		kept.push({
			userId: membership.userId,
			role: membership.role,
			newRole: entry.role,
		});
	}
	if (!kept.some((membership) => membership.newRole === "instructor")) {
		return "no_instructor";
	}

	let roleChanged = 0;
	for (const membership of kept) {
		if (membership.newRole === membership.role) continue;
		await trx
			.updateTable("lti_memberships")
			.set({ role: membership.newRole })
			.where("context_id", "=", course.id)
			.where("user_id", "=", membership.userId)
			.execute();
		roleChanged += 1;
	}

	if (gone.length > 0) {
		await trx
			.deleteFrom("lti_memberships")
			.where("context_id", "=", course.id)
			.where("user_id", "in", gone)
			.execute();
	}
	for (const userId of gone) {
		await recordAudit(trx, {
			actor,
			target: userId,
			action: "course.member_removed",
			result: "ok",
			metadata: { contextId: course.id, source: "roster" },
		});
	}

	const notStarted = active.filter((member) => !onRoster.has(member.userId));
	await trx
		.deleteFrom("lti_roster_members")
		.where("context_id", "=", course.id)
		.execute();
	if (notStarted.length > 0) {
		await trx
			.insertInto("lti_roster_members")
			.values(
				notStarted.map((member) => ({
					context_id: course.id,
					subject: member.userId,
					display_name: member.name ?? UNNAMED_MEMBER,
					role: member.role,
				})),
			)
			.execute();
	}

	const counts: Counts = {
		matched: kept.length,
		notStarted: notStarted.length,
		removed: gone.length,
		roleChanged,
	};
	await trx
		.updateTable("lti_contexts")
		.set({ roster_synced_at: now, roster_sync_result: "ok" })
		.where("id", "=", course.id)
		.execute();
	// Counts only: no names or subjects (ADR 0012).
	await recordAudit(trx, {
		actor,
		target: course.id,
		action: "course.roster_synced",
		result: "ok",
		metadata: { result: "ok", ...counts },
	});
	return counts;
}

/** Record a sync that applied nothing; `roster_synced_at` is when the last sync ran. */
async function recordFailure(
	db: Kysely<Database>,
	courseId: string,
	result: RosterSyncResult,
	status: number | null,
	actor: string,
	now: string,
): Promise<void> {
	await db.transaction().execute(async (trx) => {
		await trx
			.updateTable("lti_contexts")
			.set({ roster_synced_at: now, roster_sync_result: result })
			.where("id", "=", courseId)
			.execute();
		await recordAudit(trx, {
			actor,
			target: courseId,
			action: "course.roster_synced",
			result: "failed",
			metadata: { result, ...(status !== null ? { status } : {}) },
		});
	});
}

async function runSync(
	deps: RosterDeps,
	courseId: string,
	actor: string,
): Promise<RosterSyncResponse> {
	const { db, lti, proxyUrl, log } = deps;
	const course = await selectRosterCourse(db, courseId).executeTakeFirstOrThrow();
	const source = rosterSource(lti, course);
	if (!source) return { roster: courseRoster(lti, course), ...NO_CHANGES };

	let members: NrpsMember[];
	try {
		const accessToken = await requestNrpsToken({
			tokenUrl: source.tokenUrl,
			clientId: source.clientId,
			toolKeyPem: source.toolKeyPem,
			kid: toolJwks(source.toolKeyPem).keys[0]?.kid ?? "",
			proxyUrl,
		});
		members = await fetchNrpsMembers({
			membershipsUrl: source.membershipsUrl,
			accessToken,
			proxyUrl,
		});
	} catch (error) {
		const result = failureResult(error);
		const status = error instanceof NrpsError ? error.status : null;
		log.warn({ courseId, result, status }, "roster sync failed");
		await recordFailure(db, courseId, result, status, actor, new Date().toISOString());
		return await finished(deps, courseId, NO_CHANGES);
	}

	const active = members.filter((member) => member.status === "Active");
	if (active.length === 0) {
		log.warn({ courseId, result: "empty" }, "roster sync failed");
		await recordFailure(db, courseId, "empty", null, actor, new Date().toISOString());
		return await finished(deps, courseId, NO_CHANGES);
	}

	const counts = await db.transaction().execute(async (trx) => {
		// Holding the course row also waits out a launch refreshing it.
		const locked = await selectRosterCourse(trx, courseId)
			.forUpdate()
			.executeTakeFirstOrThrow();
		return applyRoster(trx, locked, active, actor, new Date().toISOString());
	});
	if (counts === "no_instructor") {
		log.warn({ courseId, result: counts }, "roster sync failed");
		await recordFailure(db, courseId, counts, null, actor, new Date().toISOString());
		return await finished(deps, courseId, NO_CHANGES);
	}
	log.info({ courseId, ...counts }, "roster synced");
	return await finished(deps, courseId, counts);
}

async function finished(
	deps: RosterDeps,
	courseId: string,
	counts: Counts,
): Promise<RosterSyncResponse> {
	const course = await selectRosterCourse(deps.db, courseId).executeTakeFirstOrThrow();
	return { roster: courseRoster(deps.lti, course), ...counts };
}

/**
 * Sync one course's roster from its LMS. A second call while one runs gets
 * the running sync's answer. Never rejects for an LMS failure; that is
 * recorded as the course's `roster_sync_result`.
 */
export function syncCourseRoster(
	deps: RosterDeps,
	courseId: string,
	actor: string,
): Promise<RosterSyncResponse> {
	const running = inFlight.get(courseId);
	if (running) return running;
	const run = runSync(deps, courseId, actor).finally(() => inFlight.delete(courseId));
	inFlight.set(courseId, run);
	return run;
}
