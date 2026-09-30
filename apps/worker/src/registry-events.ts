import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
	canonicalImageName,
	OTHER_IMAGES_LABEL,
	REGISTRY_EVENTS_PATH,
	REGISTRY_EVENTS_TOKEN_FILE,
	REGISTRY_EVENTS_TOKEN_HEADER,
	REGISTRY_NAMES_PER_DAY_MAX,
	type RegistryEvent,
	RegistryEventEnvelope,
	registryEventWorkspaceIp,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Logger } from "@portikus/observability";
import { type Kysely, sql } from "kysely";

/** Largest notification body read; 1000 events fit well inside it. */
const BODY_MAX_BYTES = 2 * 1024 * 1024;

const MANIFEST_TYPES = [
	"application/vnd.docker.distribution.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.v1+prettyjws",
	"application/vnd.docker.distribution.manifest.v2+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.oci.image.index.v1+json",
];
const INDEX_TYPES = [
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.oci.image.index.v1+json",
];

/**
 * The canonical image name one event counts under, or null when it does not
 * count: only manifest pulls do. A pull by tag counts under the tag. A pull
 * by digest counts as `repository@digest` only for a multi-platform index,
 * because dockerd follows every tag pull with a digest fetch of the
 * platform's own manifest, which would count the same pull twice.
 */
export function pulledImage(event: RegistryEvent, registry: string): string | null {
	if (event.action !== "pull") return null;
	if (event.request.method && event.request.method !== "GET") return null;
	const type = event.target.mediaType ?? "";
	if (!MANIFEST_TYPES.includes(type)) return null;
	const repo = `${registry}/${event.target.repository}`;
	if (event.target.tag) return canonicalImageName(`${repo}:${event.target.tag}`);
	if (event.target.digest && INDEX_TYPES.includes(type)) {
		return canonicalImageName(`${repo}@${event.target.digest}`);
	}
	return null;
}

function sameToken(given: string | undefined, expected: string): boolean {
	if (!given) return false;
	// Hash both, so the compare is constant time whatever the lengths.
	const a = createHash("sha256").update(given).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}

export interface RegistryEventsOptions {
	db: Kysely<Database>;
	logger: Logger;
	token: string;
	port: number;
	now?: () => Date;
}

/**
 * Record one envelope (ruling 7, S7): each counting pull is matched to the
 * running workspace whose bridge address the event names, and rolled up by
 * image and workspace. The address is a hint only. After
 * REGISTRY_NAMES_PER_DAY_MAX distinct names in a UTC day, new names count
 * under OTHER_IMAGES_LABEL. Returns how many pulls were stored.
 */
export async function recordRegistryEvents(
	db: Kysely<Database>,
	envelope: RegistryEventEnvelope,
	registry: string,
	now: Date,
): Promise<number> {
	const counted: { image: string; ip: string }[] = [];
	for (const event of envelope.events) {
		const image = pulledImage(event, registry);
		const ip = registryEventWorkspaceIp(event.request.addr);
		if (image && ip) counted.push({ image, ip });
	}
	if (counted.length === 0) return 0;

	const running = await db
		.selectFrom("workspaces")
		.select(["id", "agent_address"])
		.where("state", "=", "running")
		.where("agent_address", "in", [...new Set(counted.map((c) => c.ip))])
		.execute();
	const byIp = new Map(running.map((w) => [w.agent_address, w.id]));
	const pulls = new Map<string, { image: string; workspaceId: string; n: number }>();
	for (const c of counted) {
		const workspaceId = byIp.get(c.ip);
		if (!workspaceId) continue;
		const key = `${c.image}\t${workspaceId}`;
		const entry = pulls.get(key) ?? { image: c.image, workspaceId, n: 0 };
		entry.n++;
		pulls.set(key, entry);
	}
	if (pulls.size === 0) return 0;

	const at = now.toISOString();
	const day = at.slice(0, 10);
	let stored = 0;
	await db.transaction().execute(async (trx) => {
		// Serialise writers for the day so two cannot both pass the cap.
		await sql`select pg_advisory_xact_lock(hashtext(${`docker_pulls:${day}`}))`.execute(
			trx,
		);
		const known = new Set(
			(
				await trx
					.selectFrom("docker_image_pulls")
					.select("image")
					.distinct()
					.where("last_seen", ">=", new Date(`${day}T00:00:00.000Z`))
					.execute()
			).map((r) => r.image),
		);
		known.delete(OTHER_IMAGES_LABEL);
		for (const p of pulls.values()) {
			let image = p.image;
			if (!known.has(image)) {
				if (known.size >= REGISTRY_NAMES_PER_DAY_MAX) image = OTHER_IMAGES_LABEL;
				else known.add(image);
			}
			await trx
				.insertInto("docker_image_pulls")
				.values({
					image,
					workspace_id: p.workspaceId,
					pulls: p.n,
					first_seen: at,
					last_seen: at,
				})
				.onConflict((oc) =>
					oc.columns(["image", "workspace_id"]).doUpdateSet({
						pulls: sql`docker_image_pulls.pulls + excluded.pulls`,
						last_seen: at,
					}),
				)
				.execute();
			stored += p.n;
		}
	});
	return stored;
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		total += (chunk as Buffer).length;
		if (total > BODY_MAX_BYTES) return null;
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

/**
 * The registry notification webhook on 127.0.0.1 (ruling S7). A wrong or
 * missing token header is 401; a body that fails the schema is 400 and
 * stores nothing. The ghcr.io cache posts with `?registry=ghcr.io`, since
 * an event does not say which registry it came from.
 */
export function createRegistryEventsServer(options: RegistryEventsOptions): Server {
	const { db, logger, token } = options;
	const now = options.now ?? (() => new Date());
	return createServer((req, res) => {
		const answer = (status: number): void => {
			res.writeHead(status).end();
		};
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (req.method !== "POST" || url.pathname !== REGISTRY_EVENTS_PATH) {
				return answer(404);
			}
			const header = req.headers[REGISTRY_EVENTS_TOKEN_HEADER.toLowerCase()];
			if (!sameToken(typeof header === "string" ? header : undefined, token)) {
				req.resume();
				return answer(401);
			}
			const registry = url.searchParams.get("registry") ?? "docker.io";
			if (registry !== "docker.io" && registry !== "ghcr.io") return answer(400);
			const body = await readBody(req);
			if (!body) return answer(413);
			let envelope: RegistryEventEnvelope;
			try {
				const parsed = RegistryEventEnvelope.safeParse(
					JSON.parse(body.toString("utf8")),
				);
				if (!parsed.success) return answer(400);
				envelope = parsed.data;
			} catch {
				return answer(400);
			}
			await recordRegistryEvents(db, envelope, registry, now());
			answer(200);
		})().catch((e: unknown) => {
			logger.warn(
				{ error: e instanceof Error ? e.message : String(e) },
				"registry event failed",
			);
			if (!res.headersSent) answer(500);
		});
	});
}

/**
 * Read the token file and listen on 127.0.0.1. Without a readable token
 * the webhook stays off: usage then has no pull counts, and nothing else
 * depends on it.
 */
export async function startRegistryEvents(
	options: Omit<RegistryEventsOptions, "token"> & { tokenFile?: string },
): Promise<Server | null> {
	let token: string;
	try {
		token = (
			await readFile(options.tokenFile ?? REGISTRY_EVENTS_TOKEN_FILE, "utf8")
		).trim();
	} catch {
		options.logger.warn("registry events token unreadable; pull counts are off");
		return null;
	}
	if (token.length === 0) {
		options.logger.warn("registry events token empty; pull counts are off");
		return null;
	}
	const server = createRegistryEventsServer({ ...options, token });
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, "127.0.0.1", () => resolve());
	});
	server.unref();
	return server;
}
