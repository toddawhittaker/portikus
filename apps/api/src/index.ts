import { loadConfig } from "@portikus/config";
import { buildServer } from "./server.js";

const config = loadConfig();
const app = buildServer();

await app.listen({ port: config.PORT, host: "127.0.0.1" });
console.log(`api listening on http://127.0.0.1:${config.PORT}`);
