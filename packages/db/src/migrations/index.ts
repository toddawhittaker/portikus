import type { Migration } from "kysely/migration";
import { down as down0001, up as up0001 } from "./0001_workspaces.js";
import { down as down0002, up as up0002 } from "./0002_users_sessions.js";
import { down as down0003, up as up0003 } from "./0003_terminals.js";
import { down as down0004, up as up0004 } from "./0004_projects.js";
import { down as down0005, up as up0005 } from "./0005_settings.js";
import { down as down0006, up as up0006 } from "./0006_log_level.js";
import { down as down0007, up as up0007 } from "./0007_editor_settings.js";
import { down as down0008, up as up0008 } from "./0008_preview.js";
import { down as down0009, up as up0009 } from "./0009_project_directory_id.js";
import { down as down0010, up as up0010 } from "./0010_terminal_theme.js";
import { down as down0011, up as up0011 } from "./0011_terminal_agent.js";

/**
 * Static migration map. Avoids a filesystem provider so the migrator works
 * from bundled output without reading the disk at runtime.
 */
export const migrations: Record<string, Migration> = {
	"0001_workspaces": { up: up0001, down: down0001 },
	"0002_users_sessions": { up: up0002, down: down0002 },
	"0003_terminals": { up: up0003, down: down0003 },
	"0004_projects": { up: up0004, down: down0004 },
	"0005_settings": { up: up0005, down: down0005 },
	"0006_log_level": { up: up0006, down: down0006 },
	"0007_editor_settings": { up: up0007, down: down0007 },
	"0008_preview": { up: up0008, down: down0008 },
	"0009_project_directory_id": { up: up0009, down: down0009 },
	"0010_terminal_theme": { up: up0010, down: down0010 },
	"0011_terminal_agent": { up: up0011, down: down0011 },
};
