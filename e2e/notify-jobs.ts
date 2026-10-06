import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_PORT } from "./ports";

/**
 * A fake host for the Notifications section (ADR 0052). The API reads
 * NOTIFY_FILE and writes request files into ALERTS_JOBS_DIR; the tests play
 * the root alerts job by hand. Keyed by the API's port so two runs on one
 * machine never share it.
 */
const NOTIFY_ROOT = join(tmpdir(), `portikus-e2e-notify-${API_PORT}`);
export const NOTIFY_FILE = join(NOTIFY_ROOT, "notify.json");
export const ALERTS_JOBS_DIR = join(NOTIFY_ROOT, "alerts-jobs");
