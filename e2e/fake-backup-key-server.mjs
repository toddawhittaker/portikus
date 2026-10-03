/**
 * Runs the API's fake backup key helper (apps/api/src/testing/fake-backup-key.ts) on
 * this run's socket, standing in for the root helper of an apt-installed
 * server (ADR 0044). Its state lives in a file the tests reset.
 */
import {
	fakeKey,
	startFakeBackupKey,
} from "../apps/api/dist/testing/fake-backup-key.js";

const socket = process.env.BACKUP_KEY_SOCKET;
const stateFile = process.env.BACKUP_KEY_STATE;
if (!socket || !stateFile)
	throw new Error("BACKUP_KEY_SOCKET and BACKUP_KEY_STATE are required");

await startFakeBackupKey(
	socket,
	{ identity: fakeKey("e2e server").identity, handedOut: null },
	stateFile,
);
