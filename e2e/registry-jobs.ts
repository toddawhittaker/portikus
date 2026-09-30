import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_PORT } from "./ports";

/**
 * A fake host for the Docker tab (issue #840). The API writes the root
 * cache helper's request files into REGISTRY_JOBS_DIR and reads its
 * status.json there; the tests play the helper by hand. Keyed by the API's
 * port so two runs on one machine never share it.
 */
export const REGISTRY_JOBS_DIR = join(tmpdir(), `portikus-e2e-registry-${API_PORT}`);

export interface FakeRegistryStatus {
	sizeBytes?: number;
	usedBytes?: number;
	hubUp?: boolean;
	ghcrEnabled?: boolean;
	ghcrUp?: boolean;
	hubCredentialSet?: boolean;
	lastClearedAt?: string | null;
	lastClearReason?: "admin" | "full" | "credential" | null;
}

/** Empty the directory, as a fresh install leaves it. */
export async function resetRegistryJobs(): Promise<void> {
	await rm(REGISTRY_JOBS_DIR, { recursive: true, force: true });
	await mkdir(REGISTRY_JOBS_DIR, { recursive: true });
}

/** Write status.json as the helper does: aside, then renamed. */
export async function writeRegistryStatus(
	status: FakeRegistryStatus = {},
): Promise<void> {
	const file = join(REGISTRY_JOBS_DIR, "status.json");
	await writeFile(
		`${file}.tmp`,
		JSON.stringify({
			sizeBytes: 20 * 1024 ** 3,
			usedBytes: 3 * 1024 ** 3,
			hubUp: true,
			ghcrEnabled: false,
			ghcrUp: false,
			hubCredentialSet: false,
			lastClearedAt: null,
			lastClearReason: null,
			updatedAt: new Date().toISOString(),
			...status,
		}),
	);
	await rename(`${file}.tmp`, file);
}

/** Wait for the API's next request file and take it, as the helper does first. */
export async function takeRegistryRequest(): Promise<Record<string, unknown>> {
	for (let tries = 0; tries < 100; tries++) {
		const name = (await readdir(REGISTRY_JOBS_DIR)).find((n) =>
			/^request-.*\.json$/.test(n),
		);
		if (name) {
			const path = join(REGISTRY_JOBS_DIR, name);
			const file = JSON.parse(await readFile(path, "utf8"));
			await rm(path);
			return file.request;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("the API wrote no registry request file");
}

/** Request files the API left and nobody took. */
export async function registryRequests(): Promise<string[]> {
	return (await readdir(REGISTRY_JOBS_DIR)).filter((n) => n.startsWith("request-"));
}
