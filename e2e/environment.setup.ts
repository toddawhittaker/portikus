import { expect, test } from "@playwright/test";
import { API_ORIGIN, apiLoginAs, query } from "./helpers";

/**
 * Playwright reuses an API server that is already listening on the API port
 * (`reuseExistingServer` outside CI). If that server belongs to another
 * checkout it reads a different database from the one `query()` writes, so
 * every test that sets up its data in SQL and checks it in the browser goes
 * wrong in a different way each run. Catch that here, once, with a clear
 * message instead of letting it look like flaky tests.
 */
// The next check signs Carol in, so her invitation must exist first.
test.describe.configure({ mode: "serial" });

/**
 * Only an invitation creates an SSO account (SPEC.md section 24.13), so the
 * mock people the specs sign in are invited before any spec runs. Frank
 * and Nina are left out: Frank never gets an account, and
 * admin-invitations.spec.ts invites Nina itself.
 */
test("the mock people are invited", async () => {
	for (const name of ["alice", "bob", "carol", "dave", "erin", "gail"]) {
		await query(
			`insert into account_invitations (email, display_name, role)
			 select $1, $2, 'student'
			 where not exists (select 1 from account_invitations where email = $1)`,
			[`${name}@example.edu`, name],
		);
	}
});

test("the API under test reads the same database as the test helpers", async ({
	request,
}) => {
	const marker = 100_000 + Math.floor(Math.random() * 800_000);
	await query(
		"insert into settings (id, shutdown_grace_seconds) values (1, 600) on conflict do nothing",
	);
	await query("update settings set shutdown_grace_seconds = $1 where id = 1", [marker]);
	try {
		await apiLoginAs(request, "carol");
		const response = await request.get("/admin/settings");
		expect(response.ok()).toBe(true);
		const settings = (await response.json()) as { shutdownGraceSeconds: number };
		expect(
			settings.shutdownGraceSeconds,
			`The API on ${API_ORIGIN} is reading a different database from TEST_DATABASE_URL. ` +
				"Another end-to-end run is probably already using these ports; stop it and run again.",
		).toBe(marker);
	} finally {
		await query("update settings set shutdown_grace_seconds = 600 where id = 1");
	}
});

/**
 * No worker runs under the end-to-end tests, so nothing records a controller
 * check. Mark it far ahead so every workspace reads as verified (SPEC.md
 * §18.3); the unverified marker is tested by rewriting socket messages.
 */
test("the workspace state reads as verified", async () => {
	await query(
		"insert into settings (id, shutdown_grace_seconds) values (1, 600) on conflict do nothing",
	);
	await query(
		"update settings set controller_checked_at = '2100-01-01T00:00:00Z' where id = 1",
	);
});
