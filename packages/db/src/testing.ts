import { createHash } from "node:crypto";
import { hostname } from "node:os";
import type { Kysely } from "kysely";
import pg from "pg";
import { expect } from "vitest";
import { createDb } from "./index.js";
import { migrateToLatest } from "./migrate.js";
import type { Database } from "./schema.js";

/**
 * Returns true when TEST_DATABASE_URL is set and a test database is
 * available. Use with `test.skipIf(!hasTestDb())`.
 */
export function hasTestDb(): boolean {
	return !!process.env.TEST_DATABASE_URL;
}

export interface TestDb {
	db: Kysely<Database>;
	/** Delete all rows from every application table. */
	truncate: () => Promise<void>;
	/** Destroy the connection pool. Call in afterAll. */
	close: () => Promise<void>;
}

/**
 * Every test file gets its own database, so the files can run in parallel.
 * The name carries a host identifier, the process id, and a hash of the
 * test file path: the host identifier keeps machines that share one
 * PostgreSQL server apart (process ids are only unique within a host or
 * PID namespace), the pid keeps two whole-suite runs on one machine apart,
 * and the hash keeps the files of one run apart and says which file a
 * leftover database came from. PostgreSQL identifiers stop at 63
 * characters, hence the trimmed base (30 + "_hXXXX" + "_p<pid>" + "_XXXXXXXX"
 * stays well under that).
 */
export function basePrefix(url: URL): string {
	return url.pathname
		.slice(1)
		.replace(/[^A-Za-z0-9_]/g, "_")
		.slice(0, 30);
}

/**
 * A short, stable identifier for this host, used to tell its own test
 * databases apart from another machine's. Exported so the orphan-sweep
 * test can build fixture database names that match and don't match it.
 */
export function hostId(): string {
	return createHash("sha256").update(hostname()).digest("hex").slice(0, 4);
}

function perFileDbName(url: URL, testPath: string): string {
	const hash = createHash("sha256").update(testPath).digest("hex").slice(0, 8);
	return `${basePrefix(url)}_h${hostId()}_p${process.pid}_${hash}`;
}

/**
 * Drop test databases left behind by runs whose process is gone. A test file
 * that crashes never reaches `close`, so without this the server collects
 * databases forever. Only this host's own databases are considered: a pid
 * that looks dead here might still be alive on another machine or in
 * another PID namespace sharing the same PostgreSQL server.
 */
async function dropOrphanedDbs(url: string, prefix: string): Promise<void> {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const escapedPrefix = prefix.replace(/_/g, "\\_");
		const { rows } = await client.query<{ datname: string }>(
			"SELECT datname FROM pg_database WHERE datname LIKE $1",
			[`${escapedPrefix}\\_h${hostId()}\\_p%`],
		);
		for (const { datname } of rows) {
			const pid = Number(/_p(\d+)_/.exec(datname)?.[1]);
			if (!Number.isInteger(pid) || pid <= 0 || isProcessAlive(pid)) continue;
			try {
				await client.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
			} catch {
				// Someone else is using it; leaving it behind is harmless.
			}
		}
	} finally {
		await client.end();
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Pools per test file times test files must stay under the server's
 * max_connections (100 by default), so keep each file's pool small.
 */
const TEST_POOL_SIZE = 4;

/**
 * Test users have accepted the current acceptable-use statement unless a
 * test says otherwise, so only the gate's own tests meet the gate
 * (SPEC.md section 5.1). Read through jsonb so the
 * trigger does nothing while the migration tests step below migration 0020.
 */
const ACCEPT_USE_FOR_TEST_USERS = [
	`CREATE FUNCTION test_accept_use() RETURNS trigger LANGUAGE plpgsql AS $$
	BEGIN
		IF to_jsonb(NEW) ? 'acceptable_use_version' AND to_jsonb(NEW)->>'acceptable_use_version' IS NULL THEN
			NEW := jsonb_populate_record(NEW, jsonb_build_object(
				'acceptable_use_version',
				coalesce((SELECT acceptable_use_version FROM settings WHERE id = 1), 1),
				'acceptable_use_accepted_at', now()));
		END IF;
		RETURN NEW;
	END $$`,
	"CREATE TRIGGER test_accept_use BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION test_accept_use()",
];

/**
 * Create a database of this test file's own, run migrations, and return
 * helpers. Throws if TEST_DATABASE_URL is not set.
 *
 * While the file runs, TEST_DATABASE_URL points at that private database,
 * so code that reads it (the API test config) sees the same one. `close`
 * restores it and drops the database.
 */
export async function createTestDb(): Promise<TestDb> {
	const sharedUrl = process.env.TEST_DATABASE_URL;
	if (!sharedUrl) {
		throw new Error("TEST_DATABASE_URL is not set. Skipping database tests.");
	}

	const url = new URL(sharedUrl);
	const name = perFileDbName(url, expect.getState().testPath ?? "unknown");
	await dropOrphanedDbs(sharedUrl, basePrefix(url));
	// A crashed earlier run with the same pid could have left this behind.
	await runOnServer(sharedUrl, [
		`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
		`CREATE DATABASE "${name}"`,
	]);

	url.pathname = `/${name}`;
	const ownUrl = url.toString();
	process.env.TEST_DATABASE_URL = ownUrl;

	const db = createDb(ownUrl, TEST_POOL_SIZE);
	await migrateToLatest(db);
	await runOnServer(ownUrl, ACCEPT_USE_FOR_TEST_USERS);

	const truncate = async () => {
		await db.deleteFrom("notifications").execute();
		await db.deleteFrom("account_link_intents").execute();
		await db.deleteFrom("account_links").execute();
		await db.deleteFrom("lti_memberships").execute();
		await db.deleteFrom("lti_contexts").execute();
		await db.deleteFrom("lti_login_states").execute();
		await db.deleteFrom("preview_sessions").execute();
		await db.deleteFrom("preview_grants").execute();
		await db.deleteFrom("terminals").execute();
		await db.deleteFrom("projects").execute();
		await db.deleteFrom("workspace_connections").execute();
		await db.deleteFrom("audit_events").execute();
		await db.deleteFrom("workspaces").execute();
		await db.deleteFrom("settings").execute();
		await db.deleteFrom("sessions").execute();
		await db.deleteFrom("users").execute();
	};

	const close = async () => {
		await db.destroy();
		process.env.TEST_DATABASE_URL = sharedUrl;
		await runOnServer(sharedUrl, [`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`]);
	};

	return { db, truncate, close };
}

/**
 * A database for one Playwright run. The browser suite used to migrate the
 * shared database in place, so a checkout whose migration history differed
 * (a renamed or removed migration still recorded in `kysely_migration`)
 * could not start. This database is empty, migrated from the checkout that
 * created it, and named so the orphan sweep above drops it after the run
 * is gone. The fixed ports are unchanged.
 */
export async function createRunDatabase(
	sharedUrl: string,
): Promise<{ url: string; name: string }> {
	const url = new URL(sharedUrl);
	const prefix = basePrefix(url);
	await dropOrphanedDbs(sharedUrl, prefix);
	const name = `${prefix}_h${hostId()}_p${process.pid}_e2e`;
	await runOnServer(sharedUrl, [
		`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
		`CREATE DATABASE "${name}"`,
	]);
	url.pathname = `/${name}`;
	const ownUrl = url.toString();
	const db = createDb(ownUrl, TEST_POOL_SIZE);
	try {
		await migrateToLatest(db);
	} finally {
		await db.destroy();
	}
	await runOnServer(ownUrl, ACCEPT_USE_FOR_TEST_USERS);
	return { url: ownUrl, name };
}

/** Drop the database `createRunDatabase` made. */
export async function dropRunDatabase(sharedUrl: string, name: string): Promise<void> {
	await runOnServer(sharedUrl, [`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`]);
}

/** Run statements on the shared database, used to create and drop databases. */
async function runOnServer(url: string, statements: string[]): Promise<void> {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		for (const statement of statements) {
			await client.query(statement);
		}
	} finally {
		await client.end();
	}
}

export interface TestUserOverrides {
	oidc_issuer?: string;
	oidc_subject?: string;
	email?: string | null;
	display_name?: string;
	role?: string;
	provider_role?: string;
	granted_role?: string | null;
	disabled_at?: string | null;
	shutdown_grace_seconds?: number | null;
}

/** Insert a user row and return its id. */
export async function insertTestUser(
	db: Kysely<Database>,
	overrides: TestUserOverrides = {},
): Promise<string> {
	const row = await db
		.insertInto("users")
		.values({
			oidc_issuer: "https://test.invalid",
			oidc_subject: `subject-${Math.random().toString(36).slice(2, 12)}`,
			display_name: "Test User",
			role: "student",
			...overrides,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

/** Insert a user who arrived by LTI launch, as `lti:<issuer>`, and return its id. */
export async function insertTestLtiUser(
	db: Kysely<Database>,
	issuer = "https://lms.test.invalid",
	overrides: TestUserOverrides = {},
): Promise<string> {
	return insertTestUser(db, { oidc_issuer: `lti:${issuer}`, ...overrides });
}

/** Insert a course if missing and one membership in it; returns the course id. */
export async function insertTestLtiMembership(
	db: Kysely<Database>,
	userId: string,
	options: {
		issuer?: string;
		contextId?: string;
		title?: string;
		role?: "student" | "instructor";
	} = {},
): Promise<string> {
	const course = await db
		.insertInto("lti_contexts")
		.values({
			platform_issuer: options.issuer ?? "https://lms.test.invalid",
			context_id: options.contextId ?? "course-1",
			title: options.title ?? "Test Course",
			platform_name: "Test LMS",
		})
		.onConflict((oc) =>
			oc
				.columns(["platform_issuer", "context_id"])
				.doUpdateSet({ updated_at: new Date().toISOString() }),
		)
		.returning("id")
		.executeTakeFirstOrThrow();
	await db
		.insertInto("lti_memberships")
		.values({
			context_id: course.id,
			user_id: userId,
			role: options.role ?? "student",
			last_launch_at: new Date().toISOString(),
		})
		.execute();
	return course.id;
}
