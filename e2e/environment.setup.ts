import { expect, test } from "@playwright/test";
import { apiLoginAs, query } from "./helpers";

/**
 * Playwright reuses an API server that is already listening on port 3000
 * (`reuseExistingServer` outside CI). If that server belongs to another
 * checkout it reads a different database from the one `query()` writes, so
 * every test that sets up its data in SQL and checks it in the browser goes
 * wrong in a different way each run. Catch that here, once, with a clear
 * message instead of letting it look like flaky tests.
 */
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
			"The API on port 3000 is reading a different database from TEST_DATABASE_URL. " +
				"Another end-to-end run is probably already using these ports; stop it and run again.",
		).toBe(marker);
	} finally {
		await query("update settings set shutdown_grace_seconds = 600 where id = 1");
	}
});
