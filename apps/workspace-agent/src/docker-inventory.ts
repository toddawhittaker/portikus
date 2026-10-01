/**
 * The student's Docker images and the images their containers use
 * (SPEC.md §16.5), for the worker's seed usage report. Docker runs by
 * absolute path as the agent's own user, the student.
 */
import { execFile } from "node:child_process";
import {
	AgentDockerInventory,
	INVENTORY_CONTAINERS_MAX,
	INVENTORY_DIGESTS_MAX,
	INVENTORY_IMAGES_MAX,
	INVENTORY_LAYERS_MAX,
	INVENTORY_OUTPUT_MAX_BYTES,
	INVENTORY_TAGS_MAX,
	SEED_IMAGE_MAX_LENGTH,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";

export const DOCKER_PATH = "/usr/bin/docker";

/** The whole inventory must finish within this time. */
export const INVENTORY_TIMEOUT_MS = 10_000;

/** Run docker with these arguments; reject on failure, timeout or oversize output. */
export type DockerRunner = (args: string[], timeoutMs: number) => Promise<string>;

export const runDocker: DockerRunner = (args, timeoutMs) =>
	new Promise((resolve, reject) => {
		execFile(
			DOCKER_PATH,
			args,
			// execFile kills the child and fails once stdout passes maxBuffer.
			{ timeout: timeoutMs, maxBuffer: INVENTORY_OUTPUT_MAX_BYTES, encoding: "utf8" },
			(error, stdout) => {
				if (error) reject(error);
				else resolve(stdout);
			},
		);
	});

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;

const EMPTY: AgentDockerInventory = {
	available: false,
	images: [],
	containerImageIds: [],
};

interface ImageRow {
	id: string;
	repoTags: string[];
}

/** Parse `docker image ls --no-trunc --format json`: one object per line, one line per tag. */
export function parseImageList(stdout: string): ImageRow[] {
	const byId = new Map<string, ImageRow>();
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") continue;
		const row = JSON.parse(line) as {
			ID?: unknown;
			Repository?: unknown;
			Tag?: unknown;
		};
		if (typeof row.ID !== "string" || !IMAGE_ID.test(row.ID)) continue;
		let image = byId.get(row.ID);
		if (!image) {
			if (byId.size >= INVENTORY_IMAGES_MAX) continue;
			image = { id: row.ID, repoTags: [] };
			byId.set(row.ID, image);
		}
		const repo = typeof row.Repository === "string" ? row.Repository : "<none>";
		const tag = typeof row.Tag === "string" ? row.Tag : "<none>";
		if (repo === "<none>" || tag === "<none>") continue;
		const name = `${repo}:${tag}`;
		if (name.length > SEED_IMAGE_MAX_LENGTH) continue;
		if (image.repoTags.length < INVENTORY_TAGS_MAX) image.repoTags.push(name);
	}
	return [...byId.values()];
}

/** Parse `docker ps -a --no-trunc --format json` into the image reference each container names. */
export function parseContainerImages(stdout: string): string[] {
	const refs: string[] = [];
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") continue;
		const row = JSON.parse(line) as { Image?: unknown };
		if (typeof row.Image === "string" && row.Image !== "") refs.push(row.Image);
	}
	return refs;
}

export interface InspectRow {
	layers: string[];
	repoDigests: string[];
}

/** Parse `docker image inspect` output into each image's layer diff ids and repo digests. */
export function parseInspect(stdout: string): Map<string, InspectRow> {
	const rows = new Map<string, InspectRow>();
	const parsed = JSON.parse(stdout) as unknown;
	if (!Array.isArray(parsed)) return rows;
	for (const entry of parsed as {
		Id?: unknown;
		RepoDigests?: unknown;
		RootFS?: { Layers?: unknown };
	}[]) {
		if (typeof entry?.Id !== "string") continue;
		const list = Array.isArray(entry.RootFS?.Layers) ? entry.RootFS.Layers : [];
		const digests = Array.isArray(entry.RepoDigests) ? entry.RepoDigests : [];
		rows.set(entry.Id, {
			layers: list
				.filter(
					(layer): layer is string => typeof layer === "string" && IMAGE_ID.test(layer),
				)
				.slice(0, INVENTORY_LAYERS_MAX),
			repoDigests: digests
				.filter(
					(d): d is string =>
						typeof d === "string" &&
						d.length <= SEED_IMAGE_MAX_LENGTH &&
						d.includes("@"),
				)
				.slice(0, INVENTORY_DIGESTS_MAX),
		});
	}
	return rows;
}

/**
 * Turn a container's image reference into an image id. `docker ps` shows the
 * name the container was started with, or a short id once that tag moved.
 */
export function resolveImageId(ref: string, images: ImageRow[]): string | null {
	const hex = ref.startsWith("sha256:") ? ref.slice(7) : ref;
	if (/^[a-f0-9]{12,64}$/.test(hex)) {
		const match = images.find((image) => image.id.slice(7).startsWith(hex));
		if (match) return match.id;
	}
	const lastSlash = ref.lastIndexOf("/");
	const named = ref.lastIndexOf(":") > lastSlash ? ref : `${ref}:latest`;
	const bare = named.startsWith("docker.io/library/")
		? named.slice("docker.io/library/".length)
		: named.startsWith("docker.io/")
			? named.slice("docker.io/".length)
			: named;
	const match = images.find((image) => image.repoTags.includes(bare));
	return match ? match.id : null;
}

/** Collect the inventory; any failure, timeout or oversize output gives `available: false`. */
export async function dockerInventory(
	run: DockerRunner = runDocker,
	now: () => number = Date.now,
): Promise<AgentDockerInventory> {
	const deadline = now() + INVENTORY_TIMEOUT_MS;
	const remaining = (): number => {
		const left = deadline - now();
		if (left <= 0) throw new Error("docker inventory timed out");
		return left;
	};
	try {
		const images = parseImageList(
			await run(["image", "ls", "--no-trunc", "--format", "json"], remaining()),
		);
		const refs = parseContainerImages(
			await run(["ps", "-a", "--no-trunc", "--format", "json"], remaining()),
		);
		const inspected =
			images.length === 0
				? new Map<string, InspectRow>()
				: parseInspect(
						await run(
							["image", "inspect", ...images.map((image) => image.id)],
							remaining(),
						),
					);
		const containerIds = new Set<string>();
		for (const ref of refs) {
			if (containerIds.size >= INVENTORY_CONTAINERS_MAX) break;
			const id = resolveImageId(ref, images);
			if (id) containerIds.add(id);
		}
		const result = AgentDockerInventory.safeParse({
			available: true,
			images: images.map((image) => ({
				id: image.id,
				repoTags: image.repoTags,
				repoDigests: inspected.get(image.id)?.repoDigests ?? [],
				layers: inspected.get(image.id)?.layers ?? [],
			})),
			containerImageIds: [...containerIds],
		});
		return result.success ? result.data : EMPTY;
	} catch {
		return EMPTY;
	}
}

export interface DockerInventoryRouteOptions {
	run?: DockerRunner;
}

/** `GET /docker/inventory`. Token auth comes from the server's preHandler hook. */
export async function dockerInventoryRoute(
	instance: FastifyInstance,
	options: DockerInventoryRouteOptions,
): Promise<void> {
	instance.get("/docker/inventory", async (request) => {
		const inventory = await dockerInventory(options.run);
		// Counts only: image names are the student's own business.
		request.log.debug(
			{ available: inventory.available, images: inventory.images.length },
			"docker inventory",
		);
		return inventory;
	});
}
