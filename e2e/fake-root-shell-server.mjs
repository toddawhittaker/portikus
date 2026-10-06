/**
 * Runs the API's fake root-shell helper (apps/api/src/testing/fake-root-shell.ts)
 * on this run's socket, standing in for the root helper of an apt-installed
 * server (ADR 0051). It echoes input and reports resizes; nothing runs as root.
 */
import { startFakeRootShell } from "../apps/api/dist/testing/fake-root-shell.js";

const socket = process.env.ROOT_SHELL_SOCKET;
if (!socket) throw new Error("ROOT_SHELL_SOCKET is required");

await startFakeRootShell(socket);
