/**
 * The folders a failed restore leaves in `~/projects` as
 * `.portikus-aside-<pointId>` (SPEC.md §15.8, §15.10). Only real
 * directories with exactly that name, directly in `~/projects`, are listed
 * or deleted; a symlink with that name is never followed or removed
 * (SPEC.md §24.6). Nothing here runs Git (SPEC.md §12.5).
 */
import type { Dirent } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type AgentRecoveryAside, RECOVERY_ASIDE_PREFIX } from "@portikus/contracts";
import { AgentFailure } from "./errors.js";
import { projectsDir } from "./projects.js";
import { assertId, isMissing, UUID } from "./recovery.js";

/** Entries the size walk visits per folder before it stops and says so. */
export const ASIDE_WALK_LIMIT = 10_000;

/** The point id a folder name stands for, or null for any other name. */
export function asidePointId(name: string): string | null {
	if (!name.startsWith(RECOVERY_ASIDE_PREFIX)) return null;
	const id = name.slice(RECOVERY_ASIDE_PREFIX.length);
	return UUID.test(id) ? id : null;
}

/** Every aside folder in `~/projects`, with how many files it holds. */
export async function listRecoveryAsides(
	homeDir: string,
): Promise<AgentRecoveryAside[]> {
	const root = projectsDir(homeDir);
	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
	const folders: AgentRecoveryAside[] = [];
	for (const entry of entries) {
		const pointId = asidePointId(entry.name);
		if (pointId === null || !entry.isDirectory()) continue;
		const path = join(root, entry.name);
		let info: Awaited<ReturnType<typeof lstat>>;
		try {
			info = await lstat(path);
		} catch (error) {
			if (isMissing(error)) continue;
			throw error;
		}
		if (!info.isDirectory()) continue;
		folders.push({
			pointId,
			modifiedAt: info.mtime.toISOString(),
			...(await summarize(path)),
		});
	}
	return folders;
}

/**
 * Delete one aside folder. A folder already gone is not an error; anything
 * with that name that is not a real directory is refused and left alone.
 */
export async function deleteRecoveryAside(
	homeDir: string,
	pointId: string,
): Promise<void> {
	assertId(pointId);
	const path = join(projectsDir(homeDir), `${RECOVERY_ASIDE_PREFIX}${pointId}`);
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(path);
	} catch (error) {
		if (isMissing(error)) return;
		throw error;
	}
	if (!info.isDirectory()) {
		throw new AgentFailure("BAD_REQUEST", "that is not a folder a restore set aside");
	}
	// rm removes a link inside the folder, never what it points at.
	await rm(path, { recursive: true, force: true });
}

/** Files (links included) and their bytes, by lstat, up to the walk limit. */
async function summarize(
	path: string,
): Promise<{ fileCount: number; sizeBytes: number; complete: boolean }> {
	let fileCount = 0;
	let sizeBytes = 0;
	let visited = 0;
	let complete = true;
	const pending = [path];
	while (pending.length > 0) {
		const dir = pending.pop() as string;
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			complete = false;
			continue;
		}
		for (const name of names) {
			visited += 1;
			if (visited > ASIDE_WALK_LIMIT) {
				return { fileCount, sizeBytes, complete: false };
			}
			let info: Awaited<ReturnType<typeof lstat>>;
			try {
				info = await lstat(join(dir, name));
			} catch {
				complete = false;
				continue;
			}
			if (info.isDirectory()) {
				pending.push(join(dir, name));
			} else if (info.isFile() || info.isSymbolicLink()) {
				fileCount += 1;
				if (info.isFile()) sizeBytes += info.size;
			}
		}
	}
	return { fileCount, sizeBytes, complete };
}
