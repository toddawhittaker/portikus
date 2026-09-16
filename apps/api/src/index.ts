import { ApiConfigSchema, loadConfig } from "@portikus/config";
import { createDb } from "@portikus/db";
import { buildServer } from "./server.js";

const config = loadConfig(ApiConfigSchema);
const db = createDb(config.DATABASE_URL);
const app = buildServer({ db, config });

await app.listen({ port: config.PORT, host: "127.0.0.1" });
console.log(`api listening on http://127.0.0.1:${config.PORT}`);
