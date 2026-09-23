import { existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type UsersFile, validateUsersFile } from "./schema.js";

export class UsersFileError extends Error {}

export function defaultUsersFilePath(): string {
	return join(homedir(), ".config", "portikus", "users.json");
}

// The file holds password hashes, so it must never be committable.
export function assertOutsideGitWorkTree(path: string): void {
	let dir = dirname(resolve(path));
	for (;;) {
		if (existsSync(join(dir, ".git"))) {
			throw new UsersFileError(
				`${path} is inside the Git work tree at ${dir}; keep the users file outside any repository (default ${defaultUsersFilePath()})`,
			);
		}
		const parent = dirname(dir);
		if (parent === dir) return;
		dir = parent;
	}
}

async function assertPrivateMode(path: string): Promise<void> {
	const mode = (await stat(path)).mode & 0o777;
	if ((mode & 0o077) !== 0) {
		throw new UsersFileError(
			`${path} has mode ${mode.toString(8).padStart(4, "0")}, which lets other users read it; run: chmod 600 ${path}`,
		);
	}
}

// Returns undefined when the file does not exist yet.
export async function readUsersFile(path: string): Promise<UsersFile | undefined> {
	assertOutsideGitWorkTree(path);
	if (!existsSync(path)) return undefined;
	await assertPrivateMode(path);
	let data: unknown;
	try {
		data = JSON.parse(await readFile(path, "utf8"));
	} catch {
		throw new UsersFileError(`${path} is not valid JSON`);
	}
	const result = validateUsersFile(data);
	if (!result.ok) {
		throw new UsersFileError(`${path} is not valid:\n  ${result.errors.join("\n  ")}`);
	}
	return result.file;
}

// Validates, then writes a 0600 temporary file, syncs it and renames it over the old one.
export async function writeUsersFile(path: string, file: UsersFile): Promise<void> {
	assertOutsideGitWorkTree(path);
	const result = validateUsersFile(file);
	if (!result.ok) {
		throw new UsersFileError(`refusing to write:\n  ${result.errors.join("\n  ")}`);
	}
	if (existsSync(path)) await assertPrivateMode(path);
	const dir = dirname(resolve(path));
	if (!existsSync(dir)) {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		// mkdir's mode is filtered by the umask.
		await chmod(dir, 0o700);
	}
	const temp = join(dir, `.users.json.${process.pid}.${Date.now()}.tmp`);
	const handle = await open(temp, "wx", 0o600);
	try {
		await handle.chmod(0o600);
		await handle.writeFile(`${JSON.stringify(file, null, "\t")}\n`);
		await handle.sync();
	} catch (error) {
		await handle.close();
		await rm(temp, { force: true });
		throw error;
	}
	await handle.close();
	await rename(temp, path);
	const dirHandle = await open(dir, "r");
	try {
		await dirHandle.sync();
	} finally {
		await dirHandle.close();
	}
}
