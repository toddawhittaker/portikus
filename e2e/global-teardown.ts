import { dropRunDatabase } from "../packages/db/dist/testing.js";

/**
 * Drop this run's database. A killed run leaves it behind; the next run's
 * orphan sweep removes databases whose process is gone.
 */
export default async function globalTeardown(): Promise<void> {
	const adminUrl = process.env.PORTIKUS_E2E_ADMIN_URL;
	const name = process.env.PORTIKUS_E2E_DB_NAME;
	if (!adminUrl || !name) return;
	await dropRunDatabase(adminUrl, name);
}
