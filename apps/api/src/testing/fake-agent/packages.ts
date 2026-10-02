import type { FastifyInstance } from "fastify";
import type { FakeAgentState } from "./state.js";

/** The reinstall note, like the agent's packages-route.ts (ADR 0042). */
export function registerPackageRoutes(app: FastifyInstance, s: FakeAgentState): void {
	const { reinstallNotes, keyOf } = s;
	app.get("/packages/reinstall-note", async (request) => ({
		packages: reinstallNotes.get(keyOf(request)) ?? [],
	}));
	app.post("/packages/reinstall-note/dismiss", async (request, reply) => {
		reinstallNotes.delete(keyOf(request));
		return reply.status(204).send();
	});
	app.post("/__test/reinstall-note", async (request, reply) => {
		const body = (request.body ?? {}) as { key?: string; packages: string[] };
		reinstallNotes.set(body.key ?? "", body.packages);
		return reply.status(204).send();
	});
	app.get("/__test/reinstall-note", async (request) => {
		const key = (request.query as { key?: string }).key ?? "";
		return { packages: reinstallNotes.get(key) ?? [] };
	});
}
