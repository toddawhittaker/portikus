import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_PORT } from "./ports";

/**
 * A fake host for the Workspace image section (docs/SPEC.md section 22.4; ADR 0030).
 * The API reads IMAGE_JOBS_DIR and the `images` directory beside it; the
 * tests play the root job by hand: they take the request file and write the
 * status, log, manifests, health results and aliases the real job would.
 * Keyed by the API's port so two runs on one machine never share it.
 */
export const IMAGE_ROOT = join(tmpdir(), `portikus-e2e-image-${API_PORT}`);
export const IMAGE_JOBS_DIR = join(IMAGE_ROOT, "image-jobs");
export const IMAGES_DIR = join(IMAGE_ROOT, "images");

export interface FakeImage {
	version: string;
	fingerprint: string;
	node?: "24" | "26";
	python?: "debian" | "uv-3.14";
	health?: "passed" | "failed" | null;
	packages?: Record<string, string>;
	nodeVersion?: string;
	/** Written as size.json, as the root job records it. */
	sizeBytes?: number;
}

/** Write then rename, as the root job does, so the API never reads half a file. */
async function writeAtomic(path: string, text: string): Promise<void> {
	await writeFile(`${path}.tmp`, text);
	await rename(`${path}.tmp`, path);
}

/** Empty both directories. */
export async function resetImageStore(): Promise<void> {
	await rm(IMAGE_ROOT, { recursive: true, force: true });
	await mkdir(IMAGE_JOBS_DIR, { recursive: true });
	await mkdir(IMAGES_DIR, { recursive: true });
}

export async function setAliases(
	defaultVersion: string | null,
	previous: string | null,
) {
	await writeAtomic(
		join(IMAGES_DIR, "aliases.json"),
		JSON.stringify({ default: defaultVersion, previous }),
	);
}

export async function putImage(image: FakeImage): Promise<void> {
	const dir = join(IMAGES_DIR, image.version);
	await mkdir(dir, { recursive: true });
	await writeAtomic(
		join(dir, "manifest.json"),
		JSON.stringify({
			schema: 1,
			version: image.version,
			recipeVersion: image.version.replace(/-local\..*$/, ""),
			source: image.version.includes("-local.") ? "local" : "published",
			builtAt: "2026-09-20T10:00:00.000Z",
			fingerprint: image.fingerprint,
			parameters: { node: image.node ?? "24", python: image.python ?? "debian" },
			tools: {
				node: image.nodeVersion ?? "v24.8.0",
				npm: "11.6.0",
				python3: "Python 3.13.5",
				git: "git version 2.47.3",
				docker: "Docker version 28.4.0",
				claude: "2.0.1 (Claude Code)",
				codex: "codex-cli 0.40.0",
			},
			packages: image.packages ?? { curl: "8.14.1-2", git: "1:2.47.3-0" },
		}),
	);
	if (image.sizeBytes !== undefined) {
		await writeAtomic(
			join(dir, "size.json"),
			JSON.stringify({ bytes: image.sizeBytes }),
		);
	}
	if (image.health) {
		await writeAtomic(
			join(dir, "health.json"),
			JSON.stringify({
				result: image.health,
				checkedAt: "2026-09-28T10:00:00.000Z",
				checks: [
					{ name: "node --version", ok: image.health === "passed", output: "v24" },
				],
			}),
		);
	}
}

/** Wait for the API's request file and take it, as the root job does first. */
export async function takeRequest(): Promise<{
	id: string;
	request: Record<string, string>;
}> {
	for (let tries = 0; tries < 100; tries++) {
		const name = (await readdir(IMAGE_JOBS_DIR)).find((n) =>
			/^request-.*\.json$/.test(n),
		);
		if (name) {
			const file = JSON.parse(await readFile(join(IMAGE_JOBS_DIR, name), "utf8"));
			await mkdir(join(IMAGE_JOBS_DIR, file.id), { recursive: true });
			await rename(
				join(IMAGE_JOBS_DIR, name),
				join(IMAGE_JOBS_DIR, file.id, "request.json"),
			);
			return { id: file.id, request: file.request };
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("the API wrote no request file");
}

export async function writeStatus(
	id: string,
	kind: string | null,
	state: "running" | "succeeded" | "failed" | "refused",
	step: string,
	version: string | null,
	message: string | null = null,
): Promise<void> {
	await writeAtomic(
		join(IMAGE_JOBS_DIR, id, "status.json"),
		JSON.stringify({
			id,
			kind,
			state,
			step,
			version,
			message,
			startedAt: new Date().toISOString(),
			finishedAt: state === "running" ? null : new Date().toISOString(),
		}),
	);
}

export async function writeLog(id: string, lines: string[]): Promise<void> {
	await writeAtomic(join(IMAGE_JOBS_DIR, id, "log.txt"), `${lines.join("\n")}\n`);
}
