import { renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeKeyState, fakeKey } from "../apps/api/src/testing/fake-backup-key";
import { API_PORT } from "./ports";

/**
 * The fake root backup key helper of this run (e2e/fake-backup-key-server.mjs;
 * ADR 0044). The API reaches it at BACKUP_KEY_SOCKET; its state is a file,
 * so a test can put the server's key back as setup made it.
 */
export const BACKUP_KEY_SOCKET = join(
	tmpdir(),
	`portikus-e2e-backup-key-${API_PORT}.sock`,
);
export const BACKUP_KEY_STATE = join(
	tmpdir(),
	`portikus-e2e-backup-key-${API_PORT}.json`,
);

/** The key setup made on the server, and one kept off site from another server. */
export const SERVER_KEY = fakeKey("e2e server");
export const OFFSITE_KEY = fakeKey("e2e off site");

function setKeyState(state: FakeKeyState): void {
	// Written aside and renamed in, so the helper never reads a half-written file
	// while a page in another worker asks for the key.
	const aside = `${BACKUP_KEY_STATE}.${process.pid}.tmp`;
	writeFileSync(aside, JSON.stringify(state));
	renameSync(aside, BACKUP_KEY_STATE);
}

/** The server's own key, never downloaded: the reminder shows. */
export function resetKey(): void {
	setKeyState({ identity: SERVER_KEY.identity, handedOut: null });
}
