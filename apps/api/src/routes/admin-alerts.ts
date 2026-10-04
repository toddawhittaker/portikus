import { requireRole } from "@portikus/auth";
import type { TestAlertResponse } from "@portikus/contracts";
import { alertChannelsFromConfig, sendAlert } from "@portikus/observability";
import type { FastifyInstance } from "fastify";
import type { ServerDeps } from "../deps.js";

/**
 * `POST /admin/alerts/test`: send one alert straight to every configured
 * channel, so an administrator can check the setup (STACK.md section 15).
 * It writes no notification, so the worker's forwarder never repeats it.
 */
export function registerAdminAlertRoutes(
	app: FastifyInstance,
	{ config, logger }: ServerDeps,
): void {
	const channels = alertChannelsFromConfig(config);
	app.post(
		"/admin/alerts/test",
		{ preHandler: requireRole("administrator") },
		async (_request, reply) => {
			const results = await sendAlert(channels, {
				title: "Test alert from Portikus",
				text: "An administrator sent this from the admin page to check alert delivery.",
				tone: "warning",
				at: new Date(),
			});
			for (const r of results)
				logger.info(
					{ channel: r.channel, ok: r.ok, error: r.error },
					"test alert sent",
				);
			const body: TestAlertResponse = { results };
			return reply.header("cache-control", "no-store").send(body);
		},
	);
}
