import {
	type AgentDockerInventory,
	canonicalImageName,
	isImageReference,
	SEED_REGISTRIES,
	SeedImageList,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import type { Kysely } from "kysely";
import { fetchDockerInventory } from "./agent-client.js";
import { startLoop } from "./loop.js";

/** How often every running workspace's Docker images are read. */
export const INVENTORY_SECONDS = 60 * 60;
/**
 * Usage rows older than this are deleted, once a day. Never shorter than the
 * report's USAGE_WINDOW_DAYS, or the report would miss its oldest days.
 */
export const USAGE_RETENTION_DAYS = 120;
const RETENTION_SECONDS = 24 * 60 * 60;
const INSERT_CHUNK = 1000;

type InventoryReader = (
	address: string,
	token: string,
) => Promise<AgentDockerInventory | null>;

/**
 * The name an inventory tag is compared under: canonical for Docker Hub and
 * ghcr.io, and as given (with `:latest` when bare) for any other registry,
 * which `canonicalImageName` would misread as a Docker Hub path. A name
 * outside the reference grammar is dropped.
 */
export function inventoryImageName(tag: string): string | null {
	if (!isImageReference(tag)) return null;
	const slash = tag.indexOf("/");
	const first = slash >= 0 ? tag.slice(0, slash) : "";
	const known = (SEED_REGISTRIES as readonly string[]).includes(first);
	if (slash >= 0 && !known && (/[.:]/.test(first) || first === "localhost")) {
		const last = tag.slice(tag.lastIndexOf("/") + 1);
		return /[:@]/.test(last) ? tag : `${tag}:latest`;
	}
	return canonicalImageName(tag);
}

/** `repo:tag@digest` as `repo@digest`, the form a RepoDigests entry takes. */
function withoutTag(name: string): string {
	const at = name.indexOf("@");
	const path = name.slice(0, at);
	const colon = path.lastIndexOf(":");
	return colon > path.lastIndexOf("/") ? path.slice(0, colon) + name.slice(at) : name;
}

export interface PresenceRow {
	image: string;
	inSeed: boolean;
	used: boolean;
}

/**
 * One workspace's presence rows. A seed image counts as used
 * when a container references it, or when another local image, not itself
 * a seed image, has a layer list that starts with the seed image's layers
 * (an image built from it). Any other image is "used" when a container
 * references it. A digest-pinned seed name matches an image by its
 * RepoDigests, since its tags alone never carry the digest.
 */
export function presenceRows(
	inventory: AgentDockerInventory,
	seedNames: ReadonlySet<string>,
): PresenceRow[] {
	const containers = new Set(inventory.containerImageIds);
	const seedByDigest = new Map<string, string>();
	for (const name of seedNames) {
		if (name.includes("@")) seedByDigest.set(withoutTag(name), name);
	}
	const named = inventory.images.map((image) => {
		const names = image.repoTags
			.map(inventoryImageName)
			.filter((n): n is string => n !== null);
		for (const digest of image.repoDigests) {
			const seed = seedByDigest.get(inventoryImageName(digest) ?? "");
			if (seed) names.push(seed);
		}
		return { image, names: [...new Set(names)] };
	});
	const isSeed = (names: string[]): boolean => names.some((n) => seedNames.has(n));
	const startsWith = (layers: string[], prefix: string[]): boolean =>
		prefix.length > 0 &&
		layers.length >= prefix.length &&
		prefix.every((layer, i) => layers[i] === layer);

	const rows = new Map<string, PresenceRow>();
	for (const { image, names } of named) {
		const referenced = containers.has(image.id);
		for (const name of names) {
			const inSeed = seedNames.has(name);
			const used = inSeed
				? referenced ||
					named.some(
						(other) =>
							other.image.id !== image.id &&
							!isSeed(other.names) &&
							startsWith(other.image.layers, image.layers),
					)
				: referenced;
			const before = rows.get(name);
			rows.set(name, { image: name, inSeed, used: used || (before?.used ?? false) });
		}
	}
	return [...rows.values()];
}

export interface DockerUsageOptions {
	db: Kysely<Database>;
	logger: Logger;
	readInventory: InventoryReader;
	now?: () => Date;
}

/**
 * Build the inventory tick: read each running workspace's
 * images through its agent and replace that workspace's presence rows. A
 * reply that fails the schema, or says Docker was unavailable, is no data:
 * the workspace's earlier rows stay until retention removes them.
 */
export function createInventoryPoll(options: DockerUsageOptions): () => Promise<void> {
	const { db, logger, readInventory } = options;
	const now = options.now ?? (() => new Date());

	return async function tick(): Promise<void> {
		try {
			const seed = await db
				.selectFrom("docker_seed")
				.select("images")
				.executeTakeFirst();
			const seedNames = new Set(
				(SeedImageList.safeParse(seed?.images).data ?? []).map(canonicalImageName),
			);
			const workspaces = await db
				.selectFrom("workspaces")
				.select(["id", "agent_address", "agent_token"])
				.where("state", "=", "running")
				.where("agent_address", "is not", null)
				.where("agent_token", "is not", null)
				.execute();
			let read = 0;
			for (const ws of workspaces) {
				if (!ws.agent_address || !ws.agent_token) continue;
				const inventory = await readInventory(ws.agent_address, ws.agent_token);
				if (!inventory?.available) continue;
				await replacePresence(db, ws.id, presenceRows(inventory, seedNames), now());
				read++;
			}
			logger.info({ workspaces: workspaces.length, read }, "docker inventory read");
		} catch (e) {
			logger.warn({ error: errorMessage(e) }, "docker inventory failed");
		}
	};
}

async function replacePresence(
	db: Kysely<Database>,
	workspaceId: string,
	rows: PresenceRow[],
	at: Date,
): Promise<void> {
	const sampledAt = at.toISOString();
	await db.transaction().execute(async (trx) => {
		await trx
			.deleteFrom("docker_image_presence")
			.where("workspace_id", "=", workspaceId)
			.execute();
		for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
			await trx
				.insertInto("docker_image_presence")
				.values(
					rows.slice(i, i + INSERT_CHUNK).map((r) => ({
						workspace_id: workspaceId,
						image: r.image,
						in_seed: r.inSeed,
						used: r.used,
						sampled_at: sampledAt,
					})),
				)
				.execute();
		}
	});
}

/** Delete usage rows and finished seed jobs older than USAGE_RETENTION_DAYS. */
export async function pruneDockerUsage(db: Kysely<Database>, now: Date): Promise<void> {
	const cutoff = new Date(now.getTime() - USAGE_RETENTION_DAYS * 86_400_000);
	await db.deleteFrom("docker_image_pulls").where("last_seen", "<", cutoff).execute();
	await db
		.deleteFrom("docker_image_presence")
		.where("sampled_at", "<", cutoff)
		.execute();
	await db.deleteFrom("docker_seed_jobs").where("finished_at", "<", cutoff).execute();
}

/** Start the inventory poll and the daily retention; returns a stop function. */
export function startDockerUsage(
	options: Omit<DockerUsageOptions, "readInventory"> & { agentPort: number },
): () => void {
	const tick = createInventoryPoll({
		...options,
		readInventory: (address, token) =>
			fetchDockerInventory(address, options.agentPort, token),
	});
	const now = options.now ?? (() => new Date());
	const prune = async (): Promise<void> => {
		try {
			await pruneDockerUsage(options.db, now());
		} catch (e) {
			options.logger.warn({ error: errorMessage(e) }, "docker usage prune failed");
		}
	};
	const stopInventory = startLoop(
		"docker inventory",
		options.logger,
		tick,
		INVENTORY_SECONDS * 1000,
	);
	const stopPrune = startLoop(
		"docker usage prune",
		options.logger,
		prune,
		RETENTION_SECONDS * 1000,
	);
	return () => {
		stopInventory();
		stopPrune();
	};
}
