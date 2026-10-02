import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { type FakeNode, removeTree } from "./fs-model.js";
import type { FakeAgentState } from "./state.js";

/** Recovery points held in memory, like the agent's recovery-routes.ts (ADR 0020). */
export function registerRecoveryRoutes(app: FastifyInstance, s: FakeAgentState): void {
	const {
		recoveryPoints,
		recoveryDeletes,
		recoveryFull,
		restoreIncomplete,
		restoreFailure,
		projectNotFound,
		keyOf,
		dirs,
		fsOf,
	} = s;
	function recoveryError(reply: FastifyReply, status: number, code: string) {
		return reply.status(status).send({ error: { code, message: code.toLowerCase() } });
	}

	/** A hash over the project's entries, the way the real agent fingerprints. */
	function fingerprintOf(entries: Map<string, FakeNode>): string {
		const hash = createHash("sha256");
		for (const key of [...entries.keys()].sort()) {
			const node = entries.get(key) as FakeNode;
			hash.update(`${key}\0${node.type}\0`);
			if (node.type === "file") hash.update(node.content);
		}
		return hash.digest("hex");
	}

	/** A copy of one project's entries, keyed by the path after the slug. */
	function projectEntries(tree: Map<string, FakeNode>, slug: string) {
		const entries = new Map<string, FakeNode>();
		for (const [key, node] of tree) {
			if (key !== slug && !key.startsWith(`${slug}/`)) continue;
			entries.set(
				key.slice(slug.length),
				node.type === "file"
					? { type: "file", content: Buffer.from(node.content) }
					: { type: "dir" },
			);
		}
		return entries;
	}

	app.post("/projects/:slug/recovery-points", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		const body = request.body as {
			projectId: string;
			pointId: string;
			skipIfFingerprint?: string;
		};
		const key = keyOf(request);
		if (!dirs(request).has(slug)) return projectNotFound(reply);
		if (recoveryFull.has(key)) return recoveryError(reply, 507, "STORAGE_FULL");
		const entries = projectEntries(fsOf(request), slug);
		const fingerprint = fingerprintOf(entries);
		if (body.skipIfFingerprint === fingerprint) {
			return { created: false, fingerprint };
		}
		const sha256 = createHash("sha256")
			.update(`${fingerprint}${body.pointId}`)
			.digest("hex");
		recoveryPoints.set(body.pointId, {
			key,
			projectId: body.projectId,
			sha256,
			entries,
		});
		let sizeBytes = 0;
		for (const node of entries.values()) {
			if (node.type === "file") sizeBytes += node.content.length;
		}
		return { created: true, sizeBytes, sha256, fingerprint };
	});

	app.post(
		"/projects/:slug/recovery-points/:pointId/restore",
		async (request, reply) => {
			const { slug, pointId } = request.params as { slug: string; pointId: string };
			const body = request.body as { projectId: string; sha256: string };
			if (!dirs(request).has(slug)) return projectNotFound(reply);
			const point = recoveryPoints.get(pointId);
			if (
				!point ||
				point.key !== keyOf(request) ||
				point.projectId !== body.projectId ||
				point.sha256 !== body.sha256
			) {
				return recoveryError(reply, 422, "RECOVERY_POINT_INVALID");
			}
			const failure = restoreFailure.get(keyOf(request));
			if (failure) return recoveryError(reply, failure[0], failure[1]);
			if (restoreIncomplete.has(keyOf(request))) {
				return recoveryError(reply, 500, "RESTORE_INCOMPLETE");
			}
			const tree = fsOf(request);
			removeTree(tree, slug);
			for (const [rest, node] of point.entries) {
				tree.set(
					`${slug}${rest}`,
					node.type === "file"
						? { type: "file", content: Buffer.from(node.content) }
						: { type: "dir" },
				);
			}
			return reply.status(204).send();
		},
	);

	app.delete("/recovery-points/:projectId/:pointId", async (request, reply) => {
		const { pointId } = request.params as { pointId: string };
		if (recoveryPoints.get(pointId)?.key === keyOf(request)) {
			recoveryPoints.delete(pointId);
		}
		return reply.status(204).send();
	});

	app.delete("/recovery-points/:projectId", async (request, reply) => {
		const { projectId } = request.params as { projectId: string };
		const key = keyOf(request);
		for (const [id, point] of [...recoveryPoints]) {
			if (point.key === key && point.projectId === projectId) recoveryPoints.delete(id);
		}
		recoveryDeletes.push(projectId);
		return reply.status(204).send();
	});

	/** Make a workspace's recovery points fail as full, or its restores as partial. */
	app.post("/__test/recovery", async (request, reply) => {
		const body = (request.body ?? {}) as {
			key?: string;
			storageFull?: boolean;
			restoreIncomplete?: boolean;
		};
		const key = body.key ?? "";
		if (body.storageFull) recoveryFull.add(key);
		else recoveryFull.delete(key);
		if (body.restoreIncomplete) restoreIncomplete.add(key);
		else restoreIncomplete.delete(key);
		return reply.status(204).send();
	});
}
