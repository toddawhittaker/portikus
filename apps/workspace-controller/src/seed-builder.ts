import {
	INSTANCE_CREATE_WAIT_SECONDS,
	SEED_VOLUME_NAME,
	type SeedInfo,
} from "@portikus/contracts";
import { errorMessage, type Logger, silentLogger } from "@portikus/observability";
import {
	CACHE_OFF_HOST_PATH,
	GHCR_CA_HOST_PATH,
	writeDockerConfig,
	writeGhcrHosts,
} from "./docker-config.js";
import type { SeedBuildHost } from "./docker-seed.js";
import {
	deleteVolumeIfPresent,
	ensureVolume,
	readCurrentImage,
	SEED_INFO_KEY,
	VolumeInUseError,
	volumeExists,
	volumePath,
} from "./host.js";
import { type IncusClient, IncusError } from "./incus.js";
import { waitForAddress } from "./start-setup.js";

/** The seed builder container and its Docker volume, while a build runs. */
export const SEED_BUILDER = "portikus-seed-builder";
export const SEED_BUILD_VOLUME = "portikus-docker-seed-build";
/** The previous seed during the swap. */
export const SEED_OLD_VOLUME = "portikus-docker-seed-old";
/** How long the builder has to run with dockerd answering. */
const SEED_BUILDER_START_SECONDS = 120;

/** The Incus side of a Docker seed build: the builder container and the seed volumes. */
export class IncusSeedBuilder implements SeedBuildHost {
	private readonly client: IncusClient;
	private readonly pool: string;
	private readonly profile: string;
	private readonly imageAlias: string;
	private readonly log: Logger;
	private readonly stopInstance: (
		name: string,
		timeoutSeconds: number,
	) => Promise<unknown>;

	constructor(opts: {
		client: IncusClient;
		pool: string;
		profile: string;
		imageAlias: string;
		logger?: Logger;
		/** The provider's clean stop, so the builder stops like any workspace. */
		stopInstance: (name: string, timeoutSeconds: number) => Promise<unknown>;
	}) {
		this.client = opts.client;
		this.pool = opts.pool;
		this.profile = opts.profile;
		this.imageAlias = opts.imageAlias;
		this.log = opts.logger ?? silentLogger();
		this.stopInstance = opts.stopInstance;
	}

	async prepareSeedBuilder(opts: { maxBytes: number; ghcr: boolean }): Promise<void> {
		// A build the controller forgot (a restart) leaves these behind.
		await this.discardSeedBuild();
		// One GiB over the cap, so an oversize seed fails the size check with a
		// clear message rather than filling the volume.
		// Shifted from the start, so files keep real owners when copies are attached elsewhere.
		await ensureVolume(
			this.client,
			this.pool,
			SEED_BUILD_VOLUME,
			Math.ceil(opts.maxBytes / 1024 ** 3) + 1,
			{
				"security.shifted": "true",
			},
		);
		// An ordinary workspace container: the workspace profile (network, ACL,
		// unprivileged, isolated idmap) and nothing that loosens it.
		await this.client.request(
			"POST",
			"/1.0/instances",
			{
				name: SEED_BUILDER,
				source: { type: "image", alias: this.imageAlias },
				profiles: [this.profile],
				devices: {
					docker: {
						type: "disk",
						pool: this.pool,
						source: SEED_BUILD_VOLUME,
						path: "/var/lib/docker",
					},
				},
			},
			undefined,
			INSTANCE_CREATE_WAIT_SECONDS,
		);
		const seedGhcr = await writeDockerConfig(
			this.client,
			SEED_BUILDER,
			{ hubMirror: true, ghcr: opts.ghcr },
			{ caPath: GHCR_CA_HOST_PATH, cacheOffPath: CACHE_OFF_HOST_PATH, log: this.log },
		);
		await this.client.request(
			"PUT",
			`/1.0/instances/${SEED_BUILDER}/state`,
			{ action: "start" },
			undefined,
			SEED_BUILDER_START_SECONDS,
		);
		const deadline = Date.now() + SEED_BUILDER_START_SECONDS * 1000;
		await waitForAddress(
			this.client,
			SEED_BUILDER,
			deadline,
			AbortSignal.timeout(SEED_BUILDER_START_SECONDS * 1000),
		);
		// The first start ran the image's /etc/hosts template over our line.
		await writeGhcrHosts(this.client, SEED_BUILDER, seedGhcr);
		while ((await this.execInSeedBuilder(["/usr/bin/docker", "info"], 30)) !== 0) {
			if (Date.now() >= deadline) {
				throw new IncusError("TIMEOUT", "dockerd in the seed builder did not start");
			}
			await new Promise((r) => setTimeout(r, 1000));
		}
	}

	async execInSeedBuilder(command: string[], timeoutSeconds: number): Promise<number> {
		const { status } = await this.client.exec(SEED_BUILDER, command, {
			timeoutSeconds,
		});
		// No reported status is not a success for a build step.
		return status ?? -1;
	}

	async seedImageVersion(): Promise<string> {
		const image = await readCurrentImage(this.client, this.imageAlias);
		const version = image.serial ?? image.fingerprint;
		if (!version) throw new IncusError("IMAGE_NOT_FOUND", "no workspace image");
		return version.slice(0, 100);
	}

	async finishSeedBuilder(): Promise<number> {
		const state = (await this.client.request(
			"GET",
			`${volumePath(this.pool, SEED_BUILD_VOLUME)}/state`,
		)) as { usage?: { used?: number } } | undefined;
		const used = state?.usage?.used;
		if (typeof used !== "number" || !(used >= 0)) {
			throw new IncusError("OPERATION_FAILED", "Incus did not report the seed's size");
		}
		// dockerd is already stopped, so a clean stop is quick.
		await this.stopInstance(SEED_BUILDER, 60);
		await this.client.request("DELETE", `/1.0/instances/${SEED_BUILDER}`);
		return Math.trunc(used);
	}

	async installSeed(info: SeedInfo): Promise<void> {
		// A shifted volume must never be attached to two instances; the
		// builder is gone, so nothing may still use the build volume.
		const build = (await this.client.request(
			"GET",
			volumePath(this.pool, SEED_BUILD_VOLUME),
		)) as { used_by?: string[] };
		if ((build.used_by ?? []).length > 0) {
			throw new VolumeInUseError(SEED_BUILD_VOLUME);
		}
		await this.client.request("PATCH", volumePath(this.pool, SEED_BUILD_VOLUME), {
			config: { [SEED_INFO_KEY]: JSON.stringify(info) },
		});
		// Copies already made are independent of the old seed.
		await deleteVolumeIfPresent(this.client, this.pool, SEED_OLD_VOLUME);
		const hadSeed = await volumeExists(this.client, this.pool, SEED_VOLUME_NAME);
		if (hadSeed) {
			await this.client.request("POST", volumePath(this.pool, SEED_VOLUME_NAME), {
				name: SEED_OLD_VOLUME,
			});
		}
		try {
			await this.client.request("POST", volumePath(this.pool, SEED_BUILD_VOLUME), {
				name: SEED_VOLUME_NAME,
			});
		} catch (err) {
			// Put the old seed back, so new workspaces still get one.
			if (hadSeed) {
				await this.client
					.request("POST", volumePath(this.pool, SEED_OLD_VOLUME), {
						name: SEED_VOLUME_NAME,
					})
					.catch((restoreErr: unknown) =>
						this.log.warn(
							{
								err: errorMessage(restoreErr),
							},
							"could not restore the previous Docker seed",
						),
					);
			}
			throw err;
		}
		try {
			await deleteVolumeIfPresent(this.client, this.pool, SEED_OLD_VOLUME);
		} catch (err) {
			this.log.warn(
				{ err: errorMessage(err) },
				"could not delete the previous Docker seed; the next build retries",
			);
		}
		this.log.info({ sizeBytes: info.sizeBytes }, "docker seed installed");
	}

	async discardSeedBuild(): Promise<void> {
		try {
			await this.client.request(
				"PUT",
				`/1.0/instances/${SEED_BUILDER}/state`,
				{ action: "stop", force: true, timeout: 30 },
				undefined,
				60,
			);
		} catch (err) {
			if (err instanceof IncusError && err.code === "NOT_FOUND") {
				await deleteVolumeIfPresent(this.client, this.pool, SEED_BUILD_VOLUME);
				return;
			}
			// Already stopped: Incus refuses to stop it again; the delete decides.
		}
		try {
			await this.client.request("DELETE", `/1.0/instances/${SEED_BUILDER}`);
		} catch (err) {
			if (!(err instanceof IncusError && err.code === "NOT_FOUND")) throw err;
		}
		await deleteVolumeIfPresent(this.client, this.pool, SEED_BUILD_VOLUME);
	}
}
