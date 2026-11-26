import { CurrentProjectOperation, type ProjectOperation } from "@portikus/contracts";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

/** The parts of an inject response the route tests read. */
export type SettledResponse = Pick<
	LightMyRequestResponse,
	"statusCode" | "body" | "json"
>;

function answer(statusCode: number, value: unknown): SettledResponse {
	const body = value === undefined ? "" : JSON.stringify(value);
	return {
		statusCode,
		body,
		json: (() => JSON.parse(body)) as LightMyRequestResponse["json"],
	};
}

/** Read the workspace's operation until it is no longer running. */
export async function waitForOperation(
	app: FastifyInstance,
	cookie: string,
	workspaceId: string,
	id: string,
): Promise<ProjectOperation> {
	const deadline = Date.now() + 15_000;
	for (;;) {
		const response = await app.inject({
			method: "GET",
			url: `/workspaces/${workspaceId}/project-operation`,
			headers: { cookie },
		});
		const { operation } = CurrentProjectOperation.parse(response.json());
		if (operation?.id !== id) throw new Error("the operation is gone");
		if (operation.state !== "running") return operation;
		if (Date.now() > deadline) throw new Error("the operation did not finish");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/**
 * Follow a 202 to its end and answer as the request did before it became an
 * operation: 201 with the project, 204 for a restore, or the refusal. Any
 * other response is passed through.
 */
export async function settleOperation(
	app: FastifyInstance,
	cookie: string,
	workspaceId: string,
	started: SettledResponse,
): Promise<SettledResponse> {
	if (started.statusCode !== 202) return started;
	const { id } = started.json<ProjectOperation>();
	const done = await waitForOperation(app, cookie, workspaceId, id);
	if (done.error) {
		return answer(done.error.status, {
			code: done.error.code,
			message: done.error.message,
		});
	}
	return done.project ? answer(201, done.project) : answer(204, undefined);
}
