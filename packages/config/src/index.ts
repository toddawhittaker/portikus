import { z } from "zod";

/** Positive integer coerced from a string environment variable. */
const positiveInt = z.coerce.number().int().positive();

const DEV_TOKEN = "dev-controller-token-not-for-production";
const DEV_SESSION_SECRET = "dev-session-secret-not-for-production";
const DEV_CLIENT_SECRET = "portikus-dev-secret";

/**
 * Fields shared by all service configurations (STACK.md §5, §9).
 */
const BaseConfig = z.object({
	NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
	PORT: positiveInt.default(3000),
});

/**
 * In production a secret must be set explicitly, be at least 32 characters,
 * and never be a published development default (SPEC.md §24).
 */
function requireProductionSecret<F extends string>(
	field: F,
	devDefault: string,
): (data: { NODE_ENV: string } & Record<F, string>) => boolean {
	return (data) => {
		if (data.NODE_ENV !== "production") return true;
		const value = data[field];
		if (value === devDefault) return false;
		return value.length >= 32;
	};
}

function productionSecretMessage(field: string): string {
	return (
		`${field} must be set in production, be at least 32 characters, ` +
		"and must not be the development default"
	);
}

/**
 * In production browser-facing and issuer URLs must use TLS (SPEC.md §5.3).
 */
function requireProductionHttps<F extends string>(
	field: F,
): (data: { NODE_ENV: string } & Record<F, string>) => boolean {
	return (data) => data.NODE_ENV !== "production" || data[field].startsWith("https://");
}

function productionHttpsMessage(field: string): string {
	return `${field} must use https in production`;
}

/**
 * Environment contract for the API process (STACK.md §5, §9).
 */
export const ApiConfigSchema = BaseConfig.extend({
	DATABASE_URL: z.string().min(1),
	PRESENCE_TTL_SECONDS: positiveInt.default(60),
	WORKSPACE_HOME_SIZE_GIB: positiveInt.default(25),
	WORKSPACE_DOCKER_SIZE_GIB: positiveInt.default(20),
	PUBLIC_URL: z.string().url().default("http://127.0.0.1:5173"),
	OIDC_ISSUER_URL: z.string().url().default("http://127.0.0.1:3002"),
	OIDC_CLIENT_ID: z.string().min(1).default("portikus-dev"),
	OIDC_CLIENT_SECRET: z.string().min(1).default(DEV_CLIENT_SECRET),
	OIDC_SCOPES: z.string().min(1).default("openid profile email"),
	OIDC_GROUPS_CLAIM: z.string().min(1).default("groups"),
	OIDC_STUDENT_GROUP: z.string().min(1).default("portikus-students"),
	OIDC_ADMIN_GROUP: z.string().min(1).default("portikus-administrators"),
	SESSION_COOKIE_SECRET: z.string().min(1).default(DEV_SESSION_SECRET),
	SESSION_TTL_SECONDS: positiveInt.default(43200),
})
	.refine(requireProductionHttps("PUBLIC_URL"), {
		message: productionHttpsMessage("PUBLIC_URL"),
		path: ["PUBLIC_URL"],
	})
	.refine(requireProductionHttps("OIDC_ISSUER_URL"), {
		message: productionHttpsMessage("OIDC_ISSUER_URL"),
		path: ["OIDC_ISSUER_URL"],
	})
	.refine(requireProductionSecret("OIDC_CLIENT_SECRET", DEV_CLIENT_SECRET), {
		message: productionSecretMessage("OIDC_CLIENT_SECRET"),
		path: ["OIDC_CLIENT_SECRET"],
	})
	.refine(requireProductionSecret("SESSION_COOKIE_SECRET", DEV_SESSION_SECRET), {
		message: productionSecretMessage("SESSION_COOKIE_SECRET"),
		path: ["SESSION_COOKIE_SECRET"],
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
}).refine(
	requireProductionSecret("CONTROLLER_TOKEN", DEV_TOKEN),
	productionSecretMessage("CONTROLLER_TOKEN"),
);
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
}).refine(
	requireProductionSecret("CONTROLLER_TOKEN", DEV_TOKEN),
	productionSecretMessage("CONTROLLER_TOKEN"),
);
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
