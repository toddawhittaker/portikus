/**
 * `portikus reset-admin` runs this as the portikus user with the API's
 * environment (SPEC.md section 5.1):
 *   node reset-admin-main.js [--if-missing] [--email <address>]
 * Standard output carries only the new password; see runResetAdmin.
 */
import { createDb } from "@portikus/db";
import { loadDexApi } from "./dex-api.js";
import { runResetAdmin } from "./local-admin.js";

const url = process.env.DATABASE_URL;
let dex: Awaited<ReturnType<typeof loadDexApi>>;
try {
	dex = await loadDexApi({
		DEX_GRPC_ADDR: process.env.DEX_GRPC_ADDR,
		DEX_GRPC_CA: process.env.DEX_GRPC_CA,
		DEX_GRPC_CERT: process.env.DEX_GRPC_CERT,
		DEX_GRPC_KEY: process.env.DEX_GRPC_KEY,
	});
} catch (error) {
	// A settings problem, like the missing DATABASE_URL below: one line, exit 2.
	process.stderr.write(
		`Cannot load the Dex gRPC settings: ${(error as Error).message}\n`,
	);
	process.exit(2);
}
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
