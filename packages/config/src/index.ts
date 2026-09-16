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

/** Rejects a short CONTROLLER_TOKEN in production. */
function requireProductionToken<
	T extends { NODE_ENV: string; CONTROLLER_TOKEN: string },
>(data: T): boolean {
	if (data.NODE_ENV === "production" && data.CONTROLLER_TOKEN.length < 32) {
		return false;
	}
	return true;
}

const productionTokenMessage =
	"CONTROLLER_TOKEN must be at least 32 characters in production";

/**
 * Environment contract for the API process (STACK.md §5, §9).
 */
export const ApiConfigSchema = BaseConfig.extend({
	DATABASE_URL: z.string().min(1),
	CONTROLLER_URL: z.string().url().default("http://127.0.0.1:3001"),
	CONTROLLER_TOKEN: z.string().default(DEV_TOKEN),
	PRESENCE_TTL_SECONDS: positiveInt.default(60),
	WORKSPACE_HOME_SIZE_GIB: positiveInt.default(25),
	WORKSPACE_DOCKER_SIZE_GIB: positiveInt.default(20),
}).refine(requireProductionToken, productionTokenMessage);
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
	INCUS_SOCKET: z.string().min(1).default("/var/run/incus/unix.socket"),
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
 * Parse `env` (by default `process.env`) into a validated config object.
 * Throws a {@link ConfigError} naming every variable that is missing or
 * wrong.
 *
 * When called with no schema argument, defaults to {@link ApiConfigSchema}
 * for backward compatibility with existing callers.
 */
export function loadConfig(env?: NodeJS.ProcessEnv): ApiConfig;
export function loadConfig<T extends z.ZodType>(
	schema: T,
	env?: NodeJS.ProcessEnv,
): z.infer<T>;
export function loadConfig(
	schemaOrEnv?: z.ZodType | NodeJS.ProcessEnv,
	maybeEnv?: NodeJS.ProcessEnv,
): unknown {
	let schema: z.ZodType;
	let env: NodeJS.ProcessEnv;

	if (
		schemaOrEnv === undefined ||
		(typeof schemaOrEnv === "object" && !("parse" in schemaOrEnv))
	) {
		// Called as loadConfig() or loadConfig(env) -- backward-compatible
		schema = ApiConfigSchema;
		env = (schemaOrEnv as NodeJS.ProcessEnv | undefined) ?? process.env;
	} else {
		schema = schemaOrEnv as z.ZodType;
		env = maybeEnv ?? process.env;
	}

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

// Legacy aliases for backward compatibility
export const ConfigSchema = ApiConfigSchema;
export type Config = ApiConfig;
