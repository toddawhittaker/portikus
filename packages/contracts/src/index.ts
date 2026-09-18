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

export * from "./agent.js";
export * from "./auth.js";
export * from "./controller.js";
export * from "./events.js";
export * from "./files.js";
export * from "./git.js";
export * from "./project.js";
export * from "./settings.js";
export * from "./terminal.js";
export * from "./workspace.js";
