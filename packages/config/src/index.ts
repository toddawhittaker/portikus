import { LogLevel, parseProjectTemplates } from "@portikus/contracts";
import { z } from "zod";

/** Positive integer coerced from a string environment variable. */
const positiveInt = z.coerce.number().int().positive();

/** Non-negative integer coerced from a string environment variable. */
const nonNegativeInt = z.coerce.number().int().nonnegative();

const DEV_TOKEN = "dev-controller-token-not-for-production";
const DEV_SESSION_SECRET = "dev-session-secret-not-for-production";
const DEV_CLIENT_SECRET = "portikus-dev-secret";

/**
 * Fields shared by all service configurations (STACK.md §5, §9).
 */
const BaseConfig = z.object({
	NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
	PORT: positiveInt.default(3000),
	/** How much this service logs; the admin setting can override it at runtime. */
	LOG_LEVEL: LogLevel.default("info"),
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

/** The development preview suffix; production must set its own. */
const DEV_PREVIEW_SUFFIX = "preview.localhost";

/**
 * A valid, fully lowercase DNS name of at least two labels, each 1-63
 * characters, with no leading or trailing hyphen (BROWSER-HANDLING.md §23).
 */
const DNS_NAME =
	/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Parse a comma-separated port list, rejecting anything that is not a port. */
function parsePorts(value: string): number[] {
	const ports: number[] = [];
	for (const part of value.split(",")) {
		const text = part.trim();
		if (text === "") continue;
		if (!/^[1-9][0-9]{0,4}$/.test(text)) {
			throw new Error(`"${text}" is not a port number`);
		}
		const port = Number(text);
		if (port > 65535) throw new Error(`"${text}" is not a port number`);
		ports.push(port);
	}
	return ports;
}

/**
 * Environment contract for the API process (STACK.md §5, §9).
 */
export const ApiConfigSchema = BaseConfig.extend({
	DATABASE_URL: z.string().min(1),
	PRESENCE_TTL_SECONDS: positiveInt.default(60),
	WORKSPACE_HOME_SIZE_GIB: positiveInt.default(25),
	WORKSPACE_DOCKER_SIZE_GIB: positiveInt.default(20),
	/** Recovery allowance per workspace (SPEC.md §19.1, ADR 0020). */
	WORKSPACE_RECOVERY_SIZE_GIB: positiveInt.default(3),
	/** How long a recovery point is kept before retention may remove it (SPEC.md §15.7). */
	RECOVERY_RETENTION_DAYS: positiveInt.default(14),
	PUBLIC_URL: z.string().url().default("http://127.0.0.1:5173"),
	OIDC_ISSUER_URL: z.string().url().default("http://127.0.0.1:3002"),
	OIDC_CLIENT_ID: z.string().min(1).default("portikus-dev"),
	OIDC_CLIENT_SECRET: z.string().min(1).default(DEV_CLIENT_SECRET),
	OIDC_SCOPES: z.string().min(1).default("openid profile email"),
	/** Empty means no claim carries roles (Dex's Google upstream sends no groups). */
	OIDC_GROUPS_CLAIM: z.string().default("groups"),
	OIDC_STUDENT_GROUP: z.string().min(1).default("portikus-students"),
	OIDC_ADMIN_GROUP: z.string().min(1).default("portikus-administrators"),
	/** The group whose members are instructors (docs/archive/epics/EPIC-13.md ruling 4). */
	OIDC_INSTRUCTOR_GROUP: z.string().min(1).default("portikus-instructors"),
	/** What a signed-in person gets when no group matches (SPEC.md section 5.1). */
	OIDC_DEFAULT_ROLE: z.enum(["none", "student"]).default("none"),
	/** Retired by ADR 0031; read only so an old api.env stops the API instead of being ignored. */
	OIDC_PROVIDER: z.string().optional(),
	OIDC_ALLOWED_TENANT: z.string().optional(),
	OIDC_ALLOWED_DOMAINS: z.string().optional(),
	/** Forward proxy for discovery, token, keyset and LMS keyset requests (ruling 27). */
	OUTBOUND_PROXY_URL: z.string().url().optional(),
	/** Dex gRPC API address and mutual TLS files; unset turns the Dex user routes off (rulings 20, 24). */
	DEX_GRPC_ADDR: z.string().min(1).optional(),
	DEX_GRPC_CA: z.string().min(1).optional(),
	DEX_GRPC_CERT: z.string().min(1).optional(),
	DEX_GRPC_KEY: z.string().min(1).optional(),
	/** The LTI platforms file (docs/archive/epics/EPIC-13.md ruling 14); unset means LTI is off. */
	LTI_PLATFORMS_FILE: z.string().min(1).optional(),
	/** The tool's RSA key, whose public half `/lti/jwks` serves (ruling 15). */
	LTI_TOOL_KEY_FILE: z.string().min(1).optional(),
	SESSION_COOKIE_SECRET: z.string().min(1).default(DEV_SESSION_SECRET),
	SESSION_TTL_SECONDS: positiveInt.default(43200),
	AGENT_PORT: positiveInt.default(7400),
	/** `name=url,name=url` (SPEC.md §7.2); parsed once in the transform below. */
	PROJECT_TEMPLATES: z.string().default(""),
	/**
	 * DNS suffix every preview host sits under, as
	 * `<workspace-label>-<port>.<suffix>` (BROWSER-HANDLING.md §8, §23).
	 * Production must set its own; the default is for development only.
	 */
	PREVIEW_SUFFIX: z.string().min(1).default(DEV_PREVIEW_SUFFIX),
	/** Lowest port a preview may target (BROWSER-HANDLING.md §8, §23). */
	PREVIEW_PORT_MIN: positiveInt.default(1024),
	/** Highest port a preview may target (BROWSER-HANDLING.md §8, §23). */
	PREVIEW_PORT_MAX: positiveInt.default(65535),
	/**
	 * Comma-separated ports a preview may never reach, even when something
	 * is listening: SSH, the Docker API, and PostgreSQL by default. The
	 * workspace agent's own port is always added (BROWSER-HANDLING.md §8).
	 */
	PREVIEW_DENIED_PORTS: z.string().default("22,2375,2376,5432"),
	/** How long a single-use bootstrap ticket lives (BROWSER-HANDLING.md §9.1). */
	PREVIEW_TICKET_TTL_SECONDS: positiveInt.default(30),
	/** Sign-in starts per address per minute (#398): 150 lets a lab of 30 behind one address sign in, at five starts each. */
	SIGNIN_START_LIMIT_PER_MINUTE: positiveInt.default(150),
	/** Dex password posts per address per ten minutes; ten times this overall (#398). */
	PASSWORD_ATTEMPT_LIMIT_PER_10_MINUTES: positiveInt.default(30),
})
	// Silently dropping a tenant or domain check would admit any account (SPEC.md 5.1).
	.refine(
		(config) =>
			(config.OIDC_PROVIDER === undefined ||
				config.OIDC_PROVIDER === "" ||
				config.OIDC_PROVIDER === "oidc") &&
			!config.OIDC_ALLOWED_TENANT &&
			!config.OIDC_ALLOWED_DOMAINS,
		{
			message:
				"OIDC_PROVIDER, OIDC_ALLOWED_TENANT and OIDC_ALLOWED_DOMAINS are no longer supported: " +
				"Dex is now the only front door (SPEC.md 5.1); rerun the play to move this site's sign-in to Dex",
			path: ["OIDC_PROVIDER"],
		},
	)
	.refine(requireProductionHttps("PUBLIC_URL"), {
		message: productionHttpsMessage("PUBLIC_URL"),
		path: ["PUBLIC_URL"],
	})
	.refine(requireProductionHttps("OIDC_ISSUER_URL"), {
		message: productionHttpsMessage("OIDC_ISSUER_URL"),
		path: ["OIDC_ISSUER_URL"],
	})
	.refine(
		(config) => {
			const set = [
				config.DEX_GRPC_ADDR,
				config.DEX_GRPC_CA,
				config.DEX_GRPC_CERT,
				config.DEX_GRPC_KEY,
			].filter((value) => value !== undefined).length;
			return set === 0 || set === 4;
		},
		{
			message:
				"DEX_GRPC_ADDR, DEX_GRPC_CA, DEX_GRPC_CERT and DEX_GRPC_KEY are set together",
			path: ["DEX_GRPC_ADDR"],
		},
	)
	.refine(requireProductionSecret("OIDC_CLIENT_SECRET", DEV_CLIENT_SECRET), {
		message: productionSecretMessage("OIDC_CLIENT_SECRET"),
		path: ["OIDC_CLIENT_SECRET"],
	})
	.refine(requireProductionSecret("SESSION_COOKIE_SECRET", DEV_SESSION_SECRET), {
		message: productionSecretMessage("SESSION_COOKIE_SECRET"),
		path: ["SESSION_COOKIE_SECRET"],
	})
	.refine(
		(config) =>
			config.NODE_ENV !== "production" || config.PREVIEW_SUFFIX !== DEV_PREVIEW_SUFFIX,
		{
			message: "PREVIEW_SUFFIX must be set in production",
			path: ["PREVIEW_SUFFIX"],
		},
	)
	.refine((config) => DNS_NAME.test(config.PREVIEW_SUFFIX), {
		message:
			"PREVIEW_SUFFIX must be a lowercase DNS name of at least two labels, " +
			"with no scheme, port, or trailing dot",
		path: ["PREVIEW_SUFFIX"],
	})
	// A preview must never share the application's host, and wildcard
	// routing under the suffix must never cover it (BROWSER-HANDLING.md §23).
	.refine(
		(config) => {
			let appHost: string;
			try {
				appHost = new URL(config.PUBLIC_URL).hostname.toLowerCase();
			} catch {
				return true;
			}
			const suffix = config.PREVIEW_SUFFIX.toLowerCase();
			return appHost !== suffix && !appHost.endsWith(`.${suffix}`);
		},
		{
			message:
				"PREVIEW_SUFFIX must not equal or contain the PUBLIC_URL host: " +
				"previews must be a separate browser origin",
			path: ["PREVIEW_SUFFIX"],
		},
	)
	.refine((config) => config.PREVIEW_PORT_MIN <= config.PREVIEW_PORT_MAX, {
		message: "PREVIEW_PORT_MIN must not be greater than PREVIEW_PORT_MAX",
		path: ["PREVIEW_PORT_MIN"],
	})
	.refine((config) => config.PREVIEW_PORT_MAX <= 65535, {
		message: "PREVIEW_PORT_MAX must not be greater than 65535",
		path: ["PREVIEW_PORT_MAX"],
	})
	// A typo must stop the API at startup, not when a student opens the
	// create dialog, so the list is parsed here and reported like any other
	// bad environment variable.
	.transform((config, ctx) => {
		let projectTemplates: ReturnType<typeof parseProjectTemplates>;
		try {
			projectTemplates = parseProjectTemplates(config.PROJECT_TEMPLATES);
		} catch (error) {
			ctx.addIssue({
				code: "custom",
				path: ["PROJECT_TEMPLATES"],
				message: error instanceof Error ? error.message : String(error),
			});
			return z.NEVER;
		}

		let denied: number[];
		try {
			denied = parsePorts(config.PREVIEW_DENIED_PORTS);
		} catch (error) {
			ctx.addIssue({
				code: "custom",
				path: ["PREVIEW_DENIED_PORTS"],
				message: error instanceof Error ? error.message : String(error),
			});
			return z.NEVER;
		}

		return {
			...config,
			projectTemplates,
			// The agent port is never a student's to reach, whatever the list says.
			previewDeniedPorts: [...new Set([...denied, config.AGENT_PORT])].sort(
				(a, b) => a - b,
			),
		};
	});
export type ApiConfig = z.infer<typeof ApiConfigSchema>;

/**
 * Environment contract for the worker process (STACK.md §5, §9).
 */
export const WorkerConfigSchema = BaseConfig.extend({
	DATABASE_URL: z.string().min(1),
	CONTROLLER_URL: z.string().url().default("http://127.0.0.1:3001"),
	CONTROLLER_TOKEN: z.string().default(DEV_TOKEN),
	/**
	 * Seeds the `settings` row on the worker's first start. After that the
	 * admin page owns the value and this variable is ignored (SPEC.md §6.4).
	 * Zero means a disconnected workspace keeps running indefinitely.
	 */
	SHUTDOWN_GRACE_SECONDS: nonNegativeInt.default(600),
	PRESENCE_TTL_SECONDS: positiveInt.default(60),
	SWEEP_INTERVAL_SECONDS: positiveInt.default(1),
	START_TIMEOUT_SECONDS: positiveInt.default(60),
	STOP_TIMEOUT_SECONDS: positiveInt.default(30),
	STATUS_REFRESH_SECONDS: positiveInt.default(15),
	WORKSPACE_HOME_SIZE_GIB: positiveInt.default(25),
	WORKSPACE_DOCKER_SIZE_GIB: positiveInt.default(20),
	/** Recovery allowance per workspace (SPEC.md §19.1, ADR 0020). */
	WORKSPACE_RECOVERY_SIZE_GIB: positiveInt.default(3),
	/** A project is due a periodic point after this long (SPEC.md §15.6). */
	RECOVERY_INTERVAL_SECONDS: positiveInt.default(900),
	/** How long a recovery point is kept before retention may remove it (SPEC.md §15.7). */
	RECOVERY_RETENTION_DAYS: positiveInt.default(14),
	/** How often the recovery loop looks for due projects (ADR 0020). */
	RECOVERY_SWEEP_SECONDS: positiveInt.default(60),
	/**
	 * The preview suffix the worker hands to the controller, which writes it
	 * into every workspace so shells and dev servers know the preview host
	 * (issue #263). Must match the API's value.
	 */
	PREVIEW_SUFFIX: z.string().min(1).default(DEV_PREVIEW_SUFFIX),
	/** The port every workspace agent listens on; must match the API value. */
	AGENT_PORT: positiveInt.default(7400),
})
	.refine(
		requireProductionSecret("CONTROLLER_TOKEN", DEV_TOKEN),
		productionSecretMessage("CONTROLLER_TOKEN"),
	)
	.refine((config) => DNS_NAME.test(config.PREVIEW_SUFFIX), {
		message:
			"PREVIEW_SUFFIX must be a lowercase DNS name of at least two labels, " +
			"with no scheme, port, or trailing dot",
		path: ["PREVIEW_SUFFIX"],
	});
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
	AGENT_PORT: positiveInt.default(7400),
}).refine(
	requireProductionSecret("CONTROLLER_TOKEN", DEV_TOKEN),
	productionSecretMessage("CONTROLLER_TOKEN"),
);
export type ControllerConfig = z.infer<typeof ControllerConfigSchema>;

/**
 * Environment contract for the workspace agent, which runs inside the
 * student container (STACK.md §10; SPEC.md §23.5).
 */
export const AgentConfigSchema = BaseConfig.extend({
	PORT: positiveInt.default(7400),
	TOKEN_PATH: z.string().min(1).default("/etc/portikus/agent.token"),
	HOME_DIR: z.string().min(1).default("/home/student"),
	/** Mount point of the recovery volume (ADR 0020). */
	RECOVERY_ROOT: z.string().min(1).default("/var/lib/portikus/recovery"),
	// Set only in tests, so they get a tmux server of their own.
	TMUX_SOCKET_NAME: z.string().optional(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

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
