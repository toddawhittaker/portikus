import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_PORT } from "./ports";

/**
 * The fake root-shell helper of this run (e2e/fake-root-shell-server.mjs;
 * ADR 0051). The API reaches it at ROOT_SHELL_SOCKET. It echoes input and
 * reports resizes, and runs no shell.
 */
export const ROOT_SHELL_SOCKET = join(tmpdir(), `portikus-e2e-root-shell-${API_PORT}.sock`);
