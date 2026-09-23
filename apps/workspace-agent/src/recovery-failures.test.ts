/**
 * Recovery failures that need a fault injected (SPEC.md §15.8, ADR 0020):
 * a restore that fails half way is rolled back, a rollback that fails says
 * so, a full disk while extracting is STORAGE_FULL, and a caller that
 * hangs up stops the point.
 */
import { randomUUID } from "node:crypto";
import type * as FsPromises from "node:fs/promises";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { collectingLogger } from "@portikus/observability/testing";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	createRecoveryPoint,
	type RecoveryPaths,
	restoreRecoveryPoint,
} from "./recovery.js";
import { buildServer } from "./server.js";

/** Renames whose source path contains this text fail. */
const failRename = { from: [] as string[] };

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FsPromises>();
	const rename: typeof actual.rename = async (from, to) => {
		if (failRename.from.some((text) => String(from).includes(text))) {
			throw Object.assign(new Error("injected"), { code: "EIO" });
		}
		return actual.rename(from, to);
	};
	return { ...actual, rename };
});

let base: string;
let paths: RecoveryPaths;
let project: string;
let fakeBin: string;
const realPath = process.env.PATH;
const projectId = randomUUID();

beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "portikus-recovery-failures-"));
	paths = { homeDir: join(base, "home"), recoveryRoot: join(base, "recovery") };
	project = join(paths.homeDir, "projects", "alpha");
	await mkdir(join(project, "src"), { recursive: true });
	await mkdir(paths.recoveryRoot, { mode: 0o700 });
	await writeFile(join(project, "a.txt"), "a1\n");
	await writeFile(join(project, "src", "b.txt"), "b1\n");
	// A tar that can pretend the disk is full or hang, and is real otherwise.
	fakeBin = join(base, "bin");
	await mkdir(fakeBin);
	await writeFile(
		join(fakeBin, "tar"),
		[
			"#!/bin/sh",
			'case " $* " in',
			'*" --extract "*) if [ -n "$FAKE_TAR_NOSPACE" ]; then cat >/dev/null; echo "tar: x: Cannot write: No space left on device" >&2; exit 2; fi ;;',
			'*" --create "*) if [ -n "$FAKE_TAR_HANG" ]; then cat >/dev/null; exec sleep 30; fi ;;',
			"esac",
			'exec /usr/bin/tar "$@"',
			"",
		].join("\n"),
	);
	await chmod(join(fakeBin, "tar"), 0o755);
	process.env.PATH = `${fakeBin}:${realPath}`;
});

afterEach(async () => {
	failRename.from = [];
	process.env.PATH = realPath;
	delete process.env.FAKE_TAR_NOSPACE;
	delete process.env.FAKE_TAR_HANG;
	await rm(base, { recursive: true, force: true });
});

async function makePoint() {
	const pointId = randomUUID();
	const result = await createRecoveryPoint(paths, {
		slug: "alpha",
		projectId,
		pointId,
	});
	if (!result.created) throw new Error("expected a point");
	return { pointId, sha256: result.sha256 };
}

function restore(pointId: string, sha256: string) {
	return restoreRecoveryPoint(paths, { slug: "alpha", projectId, pointId, sha256 });
}

async function projectState() {
	return {
		top: (await readdir(project)).sort(),
		a: await readFile(join(project, "a.txt"), "utf8"),
		b: await readFile(join(project, "src", "b.txt"), "utf8"),
		projects: (await readdir(join(paths.homeDir, "projects"))).sort(),
	};
}

test("a restore that fails while moving files in puts the project back as it was", async () => {
	const { pointId, sha256 } = await makePoint();
	await writeFile(join(project, "a.txt"), "a2\n");
	await writeFile(join(project, "new.txt"), "new\n");
	const before = await projectState();
	// Moving the staged `src` in fails after the current files went aside.
	failRename.from = [`.portikus-restore-${pointId}/src`];
	await expect(restore(pointId, sha256)).rejects.toThrow();
	expect(await projectState()).toEqual(before);
});

test("a rollback that fails is RESTORE_INCOMPLETE and keeps the aside copy", async () => {
	const { pointId, sha256 } = await makePoint();
	failRename.from = [`.portikus-restore-${pointId}/src`, `.portikus-aside-${pointId}`];
	await expect(restore(pointId, sha256)).rejects.toMatchObject({
		code: "RESTORE_INCOMPLETE",
	});
	expect(await readdir(join(paths.homeDir, "projects"))).toContain(
		`.portikus-aside-${pointId}`,
	);
});

test("a full disk while extracting is STORAGE_FULL and changes nothing", async () => {
	const { pointId, sha256 } = await makePoint();
	await writeFile(join(project, "a.txt"), "a2\n");
	const before = await projectState();
	process.env.FAKE_TAR_NOSPACE = "1";
	await expect(restore(pointId, sha256)).rejects.toMatchObject({
		code: "STORAGE_FULL",
	});
	expect(await projectState()).toEqual(before);
});

test("a caller hanging up stops the point, removes the partial file, and frees the lock", async () => {
	const token = "c".repeat(64);
	const tokenPath = join(base, "agent.token");
	await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
	const app = buildServer({
		tokenPath,
		homeDir: paths.homeDir,
		recoveryRoot: paths.recoveryRoot,
		logger: collectingLogger("debug").logger,
		listening: {
			procRoot: base,
			interfaceAddress: null,
			docker: null,
			intervalMs: 60_000,
		},
	});
	await app.listen({ host: "127.0.0.1", port: 0 });
	try {
		const { port } = app.server.address() as AddressInfo;
		const body = JSON.stringify({ projectId, pointId: randomUUID() });
		process.env.FAKE_TAR_HANG = "1";
		const pending = request({
			host: "127.0.0.1",
			port,
			method: "POST",
			path: "/projects/alpha/recovery-points",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				"content-length": Buffer.byteLength(body),
			},
		});
		pending.on("error", () => {});
		pending.end(body);
		const dir = join(paths.recoveryRoot, projectId);
		for (let i = 0; i < 100 && !(await hasPartial(dir)); i++) await delay(20);
		expect(await hasPartial(dir)).toBe(true);
		pending.destroy();
		for (let i = 0; i < 100 && (await hasPartial(dir)); i++) await delay(20);
		expect(await hasPartial(dir)).toBe(false);

		delete process.env.FAKE_TAR_HANG;
		const next = await app.inject({
			method: "POST",
			url: "/projects/alpha/recovery-points",
			headers: { authorization: `Bearer ${token}` },
			payload: { projectId, pointId: randomUUID() },
		});
		expect(next.statusCode).toBe(201);
	} finally {
		await app.close();
	}
});

async function hasPartial(dir: string): Promise<boolean> {
	const names = await readdir(dir).catch(() => [] as string[]);
	return names.some((name) => name.endsWith(".partial"));
}
