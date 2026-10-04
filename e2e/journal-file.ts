import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_PORT } from "./ports";

/**
 * The journal the fake journalctl reads (docs/adr/0036): the API's standard
 * output, appended by `tee -a`, so a test may append a kernel line too.
 */
export const E2E_JOURNAL_FILE = join(tmpdir(), `portikus-e2e-journal-${API_PORT}.log`);
