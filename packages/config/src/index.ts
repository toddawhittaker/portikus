import { z } from "zod";

/**
 * Environment contract shared by the Node services (STACK.md section 5:
 * configuration objects are Zod schemas like every other contract).
 */
export const ConfigSchema = z.object({
	NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
	PORT: z.coerce.number().int().positive().default(3000),
	DATABASE_URL: z.string().min(1),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Thrown when the environment does not satisfy {@link ConfigSchema}. */
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
 * Throws a {@link ConfigError} naming every variable that is missing or wrong.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const result = ConfigSchema.safeParse(env);
	if (result.success) {
		return result.data;
	}

	const issues = result.error.issues.map((issue) => {
		const name = issue.path.join(".") || "(root)";
		const missing =
			issue.code === "invalid_type" && env[name] === undefined
				? "is missing"
				: issue.message;
		return `${name} ${missing}`;
	});

	throw new ConfigError(issues);
}
