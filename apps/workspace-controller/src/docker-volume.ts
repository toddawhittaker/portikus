// The per-workspace Docker volume and the shared Docker seed it is copied from.
import {
	SEED_VOLUME_NAME,
	SeedInfo,
	VOLUME_CREATE_TIMEOUT_MS,
} from "@portikus/contracts";
import { errorMessage } from "@portikus/observability";
import {
	ensureVolume,
	parseIncusSize,
	SEED_INFO_KEY,
	SEED_SHARE_KEY,
	volumeExists,
	volumePath,
} from "./host.js";
import { IncusError } from "./incus.js";
import { enc, type ProviderHost } from "./provider-host.js";

/**
 * Make `<name>-docker` as a thin copy of the seed when one exists, sized
 * at the Docker size plus the seed's, else empty. A volume
 * that already exists is kept, never replaced. A copy that fails falls
 * back to an empty volume, so a broken seed never blocks a workspace.
 * The copy is only ever attached as this one instance's Docker device.
 * An abort is not a broken seed, so it never falls back (ADR 0034).
 */
export async function ensureDockerVolume(
	host: ProviderHost,
	name: string,
	dockerGiB: number,
	signal?: AbortSignal,
): Promise<void> {
	const volume = `${name}-docker`;
	let seed: SeedInfo | null = null;
	try {
		seed = await readSeedInfo(host, signal);
	} catch (err) {
		if (signal?.aborted) throw err;
		host.log.warn(
			{ instance: name, err: errorMessage(err) },
			"could not read the Docker seed; making an empty Docker volume",
		);
	}
	if (seed) {
		try {
			// A copy cannot be smaller than its source, which is the build volume's size.
			const source = (await host.client.request(
				"GET",
				volumePath(host.pool, SEED_VOLUME_NAME),
				undefined,
				signal,
			)) as { config?: Record<string, unknown> };
			const sourceGiB = Math.ceil((parseIncusSize(source.config?.size) ?? 0) / 2 ** 30);
			const totalGiB = Math.max(
				dockerGiB + Math.ceil(seed.sizeBytes / 1024 ** 3),
				sourceGiB,
			);
			await host.client.request(
				"POST",
				`/1.0/storage-pools/${enc(host.pool)}/volumes/custom`,
				{
					name: volume,
					config: {
						size: `${totalGiB}GiB`,
						"security.shifted": "true",
						[SEED_SHARE_KEY]: String(totalGiB - dockerGiB),
					},
					source: { type: "copy", pool: host.pool, name: SEED_VOLUME_NAME },
				},
				signal,
				undefined,
				VOLUME_CREATE_TIMEOUT_MS,
			);
			return;
		} catch (err) {
			if (err instanceof IncusError && err.code === "ALREADY_EXISTS") return;
			if (signal?.aborted) throw err;
			host.log.warn(
				{ instance: name, err: errorMessage(err) },
				"could not copy the Docker seed; making an empty Docker volume",
			);
			// A half-made copy would otherwise be adopted below.
			await host.client
				.request("DELETE", volumePath(host.pool, volume))
				.catch(() => {});
		}
	}
	await ensureVolume(host.client, host.pool, volume, dockerGiB, {}, signal);
}

/**
 * The seed's size when `name`'s Docker volume will be copied from it, else
 * 0. An unreadable seed counts as 0, as ensureDockerVolume then makes an
 * empty volume.
 */
export async function seedBytesFor(
	host: ProviderHost,
	name: string,
	signal?: AbortSignal,
): Promise<number> {
	try {
		const seed = await readSeedInfo(host, signal);
		if (!seed || (await volumeExists(host.client, host.pool, `${name}-docker`, signal)))
			return 0;
		return seed.sizeBytes;
	} catch (err) {
		if (signal?.aborted) throw err;
		return 0;
	}
}

export async function readSeedInfo(
	host: ProviderHost,
	signal?: AbortSignal,
): Promise<SeedInfo | null> {
	let volume: { config?: Record<string, string> };
	try {
		volume = (await host.client.request(
			"GET",
			volumePath(host.pool, SEED_VOLUME_NAME),
			undefined,
			signal,
		)) as { config?: Record<string, string> };
	} catch (err) {
		if (err instanceof IncusError && err.code === "NOT_FOUND") return null;
		throw err;
	}
	const raw = volume?.config?.[SEED_INFO_KEY];
	if (!raw) return null;
	try {
		const parsed = SeedInfo.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
