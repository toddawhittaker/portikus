import {
	type SeedBuildRequest,
	type SeedBuildStatus,
	type SeedInfo,
	seedImageListFor,
} from "@portikus/contracts";
import { errorMessage, type Logger, silentLogger } from "@portikus/observability";
import { IncusError } from "./incus.js";

/**
 * The seed build. The provider does the Incus work;
 * this file holds the order of the steps and the one-build-at-a-time rule.
 */
export interface SeedBuildHost {
	/**
	 * Make a fresh builder: an ordinary unprivileged workspace container on
	 * the workspace network, from the current image, with a new Docker volume
	 * of about `maxBytes`, the Hub mirror on, running with dockerd answering.
	 */
	prepareSeedBuilder(opts: { maxBytes: number; ghcr: boolean }): Promise<void>;
	/** Run one command in the builder, no shell; answers its exit status. */
	execInSeedBuilder(command: string[], timeoutSeconds: number): Promise<number>;
	/** The workspace image version the builder runs. */
	seedImageVersion(): Promise<string>;
	/** Measure the build volume, then stop and delete the builder. Answers bytes used. */
	finishSeedBuilder(): Promise<number>;
	/** Store `info` on the build volume and swap it in as the seed. */
	installSeed(info: SeedInfo): Promise<void>;
	/** Remove the builder and the build volume, whatever state they are in. */
	discardSeedBuild(): Promise<void>;
}

/** Answered 409: one seed build at a time. */
export class SeedBuildBusyError extends IncusError {
	constructor() {
		super("OPERATION_FAILED", "a seed build is already running");
		this.name = "SeedBuildBusyError";
	}
}

const DOCKER = "/usr/bin/docker";
/** One `docker pull` may take this long before the build fails. */
export const SEED_PULL_TIMEOUT_SECONDS = 1800;
const CLEANUP_TIMEOUT_SECONDS = 300;

/** Pull every image, clean up, stop dockerd; never through a shell. */
export function seedCommands(images: readonly string[]): {
	pulls: string[][];
	cleanup: string[][];
} {
	return {
		pulls: images.map((image) => [DOCKER, "pull", image]),
		cleanup: [
			[DOCKER, "container", "prune", "--force"],
			[DOCKER, "builder", "prune", "--all", "--force"],
			["/usr/bin/systemctl", "stop", "docker.socket", "docker.service"],
		],
	};
}

function gib(bytes: number): string {
	return (bytes / 1024 ** 3).toFixed(1);
}

export class SeedBuilds {
	private readonly builds = new Map<string, SeedBuildStatus>();
	private running: Promise<void> | null = null;

	constructor(
		private readonly host: SeedBuildHost,
		private readonly log: Logger = silentLogger(),
		private readonly now: () => Date = () => new Date(),
	) {}

	/** Start a build, or answer the one with this id. Refuses a second build while one runs. */
	start(request: SeedBuildRequest): SeedBuildStatus {
		const known = this.builds.get(request.id);
		if (known) return known;
		const list = seedImageListFor(request.ghcrEnabled).safeParse(request.images);
		if (!list.success) {
			throw new IncusError(
				"BAD_REQUEST",
				list.error.issues.map((i) => i.message).join("; "),
			);
		}
		if (this.running) throw new SeedBuildBusyError();
		const status: SeedBuildStatus = {
			id: request.id,
			state: "running",
			step: "Starting the builder",
			message: null,
			seed: null,
		};
		this.builds.set(request.id, status);
		this.running = this.run(request, status).finally(() => {
			this.running = null;
		});
		return { ...status };
	}

	get(id: string): SeedBuildStatus | undefined {
		const status = this.builds.get(id);
		return status ? { ...status } : undefined;
	}

	/** Resolves when the current build ends; for tests. */
	async idle(): Promise<void> {
		await this.running;
	}

	private async run(request: SeedBuildRequest, status: SeedBuildStatus): Promise<void> {
		const { pulls, cleanup } = seedCommands(request.images);
		const exec = async (command: string[], timeout: number): Promise<void> => {
			const code = await this.host.execInSeedBuilder(command, timeout);
			if (code !== 0) {
				throw new Error(`${command.slice(0, 3).join(" ")} exited ${code}`);
			}
		};
		try {
			await this.host.prepareSeedBuilder({
				maxBytes: request.maxBytes,
				ghcr: request.ghcrEnabled,
			});
			const imageVersion = await this.host.seedImageVersion();
			for (const [i, command] of pulls.entries()) {
				// The contract caps a step at 200 characters; a name may be 255.
				status.step =
					`Pulling ${request.images[i]} (${i + 1} of ${pulls.length})`.slice(0, 200);
				await exec(command, SEED_PULL_TIMEOUT_SECONDS);
			}
			status.step = "Cleaning up the builder";
			for (const command of cleanup) await exec(command, CLEANUP_TIMEOUT_SECONDS);
			status.step = "Measuring the seed";
			const sizeBytes = await this.host.finishSeedBuilder();
			if (sizeBytes > request.maxBytes) {
				throw new Error(
					`The seed is ${gib(sizeBytes)} GiB, over the ${gib(request.maxBytes)} GiB cap; the old seed stays`,
				);
			}
			const seed: SeedInfo = {
				images: request.images,
				sizeBytes,
				imageVersion,
				builtAt: this.now().toISOString(),
			};
			status.step = "Installing the seed";
			await this.host.installSeed(seed);
			status.state = "succeeded";
			status.step = "Done";
			status.seed = seed;
			this.log.info({ images: request.images.length, sizeBytes }, "docker seed built");
		} catch (err) {
			const message = errorMessage(err);
			this.log.warn({ err: message, step: status.step }, "docker seed build failed");
			try {
				await this.host.discardSeedBuild();
			} catch (cleanupErr) {
				this.log.warn(
					{
						err: errorMessage(cleanupErr),
					},
					"could not remove the seed builder",
				);
			}
			status.state = "failed";
			status.message = message.slice(0, 1000);
		}
	}
}
