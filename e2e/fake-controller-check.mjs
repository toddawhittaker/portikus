/**
 * Stands in for the worker's controller check, which no end-to-end run has:
 * it stamps settings.controller_checked_at every 30 seconds so workspace
 * state reads as verified (SPEC.md §18.3). A stamp in the future would read
 * as unverified, so it cannot be set once ahead of time.
 */
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

async function stamp() {
	const client = new pg.Client({ connectionString: url });
	try {
		await client.connect();
		// Before migrations or the setup project, the settings row may not exist yet.
		await client.query(
			"update settings set controller_checked_at = now() where id = 1",
		);
	} catch {
		// The next tick tries again.
	} finally {
		await client.end().catch(() => {});
	}
}

await stamp();
setInterval(stamp, 30_000);
