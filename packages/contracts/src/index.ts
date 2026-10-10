import { z } from "zod";

/**
 * Response body of `GET /health` on the control plane (SPEC.md section 27,
 * STACK.md section 5: Zod schemas are the single source of API contracts).
 */
export const HealthResponse = z.object({
	status: z.literal("ok"),
	service: z.string().min(1),
	uptimeSeconds: z.number().nonnegative(),
});

export type HealthResponse = z.infer<typeof HealthResponse>;

export * from "./admin.js";
export * from "./agent.js";
export * from "./agent-log.js";
export * from "./alerts.js";
export * from "./auth.js";
export * from "./backups.js";
export * from "./browser.js";
export * from "./certificate.js";
export * from "./checks.js";
export * from "./close-codes.js";
export * from "./controller.js";
export * from "./courses.js";
export * from "./csv.js";
export * from "./docker-cache.js";
export * from "./egress.js";
export * from "./events.js";
export * from "./files.js";
export * from "./git.js";
export * from "./guard.js";
export * from "./health-series.js";
export * from "./host.js";
export * from "./image.js";
export * from "./jobs.js";
export * from "./links.js";
export * from "./listening.js";
export * from "./logs.js";
export * from "./notifications.js";
export * from "./notify.js";
export * from "./packages.js";
export * from "./preview.js";
export * from "./processes.js";
export * from "./project.js";
export * from "./recovery.js";
export * from "./root-shell.js";
export * from "./search.js";
export * from "./settings.js";
export * from "./site.js";
export * from "./terminal.js";
export * from "./usage.js";
export * from "./workspace.js";
