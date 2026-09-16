import type { Migration } from "kysely/migration";
import { down as down0001, up as up0001 } from "./0001_workspaces.js";

/**
 * Static migration map. Avoids a filesystem provider so the migrator works
 * from bundled output without reading the disk at runtime.
 */
export const migrations: Record<string, Migration> = {
	"0001_workspaces": { up: up0001, down: down0001 },
};
