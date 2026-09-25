/**
 * `portikus reset-admin` runs this as the portikus user with the API's
 * environment (docs/EPIC-14-2.md ruling 20):
 *   node reset-admin-main.js [--if-missing] [--email <address>]
 * Standard output carries only the new password; see runResetAdmin.
 */
import { createDb } from "@portikus/db";
import { loadDexApi } from "./dex-api.js";
import { runResetAdmin } from "./local-admin.js";

const url = process.env.DATABASE_URL;
const dex = await loadDexApi({
	DEX_GRPC_ADDR: process.env.DEX_GRPC_ADDR,
	DEX_GRPC_CA: process.env.DEX_GRPC_CA,
	DEX_GRPC_CERT: process.env.DEX_GRPC_CERT,
	DEX_GRPC_KEY: process.env.DEX_GRPC_KEY,
});
if (!url || !dex) {
	process.stderr.write("DATABASE_URL and DEX_GRPC_ADDR must be set\n");
	process.exit(2);
}
const db = createDb(url, 1);
let code = 1;
try {
	code = await runResetAdmin(
		process.argv.slice(2),
		{
			db,
			dex,
			env: {
				OIDC_ISSUER_URL: process.env.OIDC_ISSUER_URL,
				PUBLIC_URL: process.env.PUBLIC_URL,
			},
		},
		{
			stdout: (text) => process.stdout.write(text),
			stderr: (text) => process.stderr.write(text),
		},
	);
} finally {
	dex.close();
	await db.destroy();
}
process.exit(code);
