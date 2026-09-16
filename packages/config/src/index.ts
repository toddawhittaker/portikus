import { z } from "zod";

/** Positive integer coerced from a string environment variable. */
const positiveInt = z.coerce.number().int().positive();

const DEV_TOKEN = "dev-controller-token-not-for-production";

/**
 * Fields shared by all service configurations (STACK.md §5, §9).
 */
const BaseConfig = z.object({
	NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
	PORT: positiveInt.default(3000),
});

/**
 * In production CONTROLLER_TOKEN must be set explicitly, be at least 32
 * characters, and never be the published development token (SPEC.md §24).
 */
function requireProductionToken<
	T extends { NODE_ENV: string; CONTROLLER_TOKEN: string },
>(data: T): boolean {
	if (data.NODE_ENV !== "production") return true;
	if (data.CONTROLLER_TOKEN === DEV_TOKEN) return false;
	return data.CONTROLLER_TOKEN.length >= 32;
}

const productionTokenMessage =
	"CONTROLLER_TOKEN must be set in production, be at least 32 characters, " +
	"and must not be the development default";

/**
 * Environment contract for the API process (STACK.md §5, §9).
 */
export const ApiConfigSchema = BaseConfig.extend({
	DATABASE_URL: z.string().min(1),
	PRESENCE_TTL_SECONDS: positiveInt.default(60),
	WORKSPACE_HOME_SIZE_GIB: positiveInt.default(25),
	WORKSPACE_DOCKER_SIZE_GIB: positiveInt.default(20),
});
export type ApiConfig = z.infer<typeof ApiConfigSchema>;

/**
 * Environment contract for the worker process (STACK.md §5, §9).
 */
export const WorkerConfigSchema = BaseConfig.extend({
	DATABASE_URL: z.string().min(1),
	CONTROLLER_URL: z.string().url().default("http://127.0.0.1:3001"),
	CONTROLLER_TOKEN: z.string().default(DEV_TOKEN),
	SHUTDOWN_GRACE_SECONDS: positiveInt.default(600),
	PRESENCE_TTL_SECONDS: positiveInt.default(60),
	SWEEP_INTERVAL_SECONDS: positiveInt.default(1),
	START_TIMEOUT_SECONDS: positiveInt.default(60),
	STOP_TIMEOUT_SECONDS: positiveInt.default(30),
	STATUS_REFRESH_SECONDS: positiveInt.default(15),
	WORKSPACE_HOME_SIZE_GIB: positiveInt.default(25),
	WORKSPACE_DOCKER_SIZE_GIB: positiveInt.default(20),
}).refine(requireProductionToken, productionTokenMessage);
export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

/**
 * Environment contract for the workspace controller process
 * (STACK.md §5, §9).
 */
export const ControllerConfigSchema = BaseConfig.extend({
	PORT: positiveInt.default(3001),
	CONTROLLER_TOKEN: z.string().default(DEV_TOKEN),
	INCUS_SOCKET: z.string().min(1).default("/var/lib/incus/unix.socket"),
	INCUS_PROJECT: z.string().min(1).default("portikus"),
	INCUS_POOL: z.string().min(1).default("workspace-data"),
	INCUS_PROFILE: z.string().min(1).default("workspace"),
	INCUS_IMAGE_ALIAS: z.string().min(1).default("portikus"),
}).refine(requireProductionToken, productionTokenMessage);
export type ControllerConfig = z.infer<typeof ControllerConfigSchema>;

/** Thrown when the environment does not satisfy the config schema. */
export class ConfigError extends Error {
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(
			`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`,
		);
		this.name = "ConfigError";
		this.issues = issues;
	}
}

/**
 * Parse `env` (by default `process.env`) against `schema`. Throws a
 * {@link ConfigError} naming every variable that is missing or wrong.
 */
export function loadConfig<T extends z.ZodType>(
	schema: T,
	env: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
	const result = schema.safeParse(env);
	if (result.success) {
		return result.data;
	}

	const issues = (result.error as z.ZodError).issues.map((issue) => {
		const name = issue.path.join(".") || "(root)";
		const missing =
			issue.code === "invalid_type" &&
			env[name as keyof NodeJS.ProcessEnv] === undefined
				? "is missing"
				: issue.message;
		return `${name} ${missing}`;
	});

	throw new ConfigError(issues);
}
