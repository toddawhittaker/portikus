import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	EGRESS_HELPER_TIMEOUT_MS,
	EgressApplyPolicy,
	type EgressApplyStatus,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import type { AppliedFile, HelperStatus } from "./helper.js";
import { EGRESS_PATHS, STATE_FILES } from "./paths.js";

export interface EgressRouteOptions {
	requestPath?: string;
	stateDir?: string;
	/** How long a PUT waits for the helper's status. */
	timeoutMs?: number;
	pollMs?: number;
}

async function readJson<T>(path: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return null;
	}
}

/**
 * `PUT /egress-policy` hands an expanded policy to the root helper through
 * its request file and waits up to 30 seconds for the helper's status;
 * `GET /egress-policy` reports what last applied (ADR 0038). The
 * controller changes no firewall, DNS or proxy state itself.
 */
export function registerEgressRoutes(
	app: FastifyInstance,
	opts: EgressRouteOptions = {},
): void {
	const requestPath = opts.requestPath ?? EGRESS_PATHS.request;
	const stateDir = opts.stateDir ?? EGRESS_PATHS.stateDir;
	const timeoutMs = opts.timeoutMs ?? EGRESS_HELPER_TIMEOUT_MS;
	const pollMs = opts.pollMs ?? 200;
	// One request at a time: the helper answers the newest request file only.
	let queue: Promise<unknown> = Promise.resolve();

	async function current(): Promise<EgressApplyStatus> {
		const applied = await readJson<AppliedFile>(join(stateDir, STATE_FILES.applied));
		const status = await readJson<HelperStatus>(join(stateDir, STATE_FILES.status));
		return {
			appliedVersion:
				typeof applied?.policy?.version === "number" ? applied.policy.version : null,
			appliedAt: typeof applied?.appliedAt === "string" ? applied.appliedAt : null,
			error:
				status && status.ok === false && typeof status.error === "string"
					? status.error
					: null,
		};
	}

	async function apply(policy: EgressApplyPolicy): Promise<HelperStatus | null> {
		const requestId = randomUUID();
		const tmp = `${requestPath}.tmp`;
		await writeFile(tmp, JSON.stringify({ requestId, ...policy }), { mode: 0o640 });
		await rename(tmp, requestPath);
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, pollMs));
			const status = await readJson<HelperStatus>(join(stateDir, STATE_FILES.status));
			if (status?.requestId === requestId) return status;
		}
		return null;
	}

	app.get("/egress-policy", async () => current());

	app.put("/egress-policy", async (request, reply) => {
		const parsed = EgressApplyPolicy.safeParse(request.body);
		if (!parsed.success) {
			return reply.code(400).send({
				code: "BAD_REQUEST",
				message: parsed.error.issues
					.map((i) => `${i.path.join(".")}: ${i.message}`)
					.join("; "),
			});
		}
		const run = queue.then(() => apply(parsed.data));
		queue = run.catch(() => undefined);
		let status: HelperStatus | null;
		try {
			status = await run;
		} catch (e) {
			return reply.code(500).send({
				code: "OPERATION_FAILED",
				message: `could not write the egress request: ${(e as Error).message}`,
			});
		}
		if (!status) {
			const last = await current();
			return reply.code(504).send({
				code: "TIMEOUT",
				message: last.error ?? "the egress helper did not answer within 30 seconds",
			});
		}
		if (!status.ok) {
			return reply.code(500).send({
				code: "OPERATION_FAILED",
				message: status.error ?? "the egress helper failed",
			});
		}
		request.log.info(
			{ version: parsed.data.version, mode: parsed.data.mode },
			"egress policy applied",
		);
		return reply.code(200).send(await current());
	});
}
