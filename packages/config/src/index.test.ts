import { expect, test } from "vitest";
import {
	ApiConfigSchema,
	ConfigError,
	ControllerConfigSchema,
	loadConfig,
	WorkerConfigSchema,
} from "./index.js";

// --- loadConfig error reporting (using the API schema) ---

test("applies defaults and coerces PORT", () => {
	const config = loadConfig(ApiConfigSchema, {
		DATABASE_URL: "postgres://localhost/portikus",
		PORT: "8080",
	});
	expect(config.NODE_ENV).toBe("development");
	expect(config.PORT).toBe(8080);
	expect(config.DATABASE_URL).toBe("postgres://localhost/portikus");
});

test("lists every missing variable in the error message", () => {
	try {
		loadConfig(ApiConfigSchema, {});
		expect.unreachable("loadConfig should have thrown");
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		expect((error as ConfigError).issues).toEqual(["DATABASE_URL is missing"]);
		expect((error as ConfigError).message).toContain("DATABASE_URL is missing");
	}
});

test("reports a value that is present but invalid", () => {
	try {
		loadConfig(ApiConfigSchema, {
			DATABASE_URL: "postgres://localhost/portikus",
			PORT: "-1",
		});
		expect.unreachable("loadConfig should have thrown");
	} catch (error) {
		expect((error as ConfigError).issues[0]).toContain("PORT");
	}
});

test("names every failing variable when more than one is wrong", () => {
	try {
		loadConfig(ApiConfigSchema, { PORT: "not-a-number" });
		expect.unreachable("loadConfig should have thrown");
	} catch (error) {
		const message = (error as ConfigError).message;
		expect(message).toContain("PORT");
		expect(message).toContain("DATABASE_URL");
		expect((error as ConfigError).issues).toHaveLength(2);
	}
});

test("reports an invalid value by name rather than by position", () => {
	try {
		loadConfig(ApiConfigSchema, {
			DATABASE_URL: "postgres://localhost/portikus",
			PORT: "abc",
		});
		expect.unreachable("loadConfig should have thrown");
	} catch (error) {
		const issues = (error as ConfigError).issues;
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatch(/^PORT /);
		expect(issues[0]).not.toContain("is missing");
	}
});

test("reads only the variables in the schema", () => {
	const config = loadConfig(ApiConfigSchema, {
		DATABASE_URL: "postgres://localhost/portikus",
		SECRET_TOKEN: "do-not-leak",
		HOME: "/home/someone",
	});
	expect(config.DATABASE_URL).toBe("postgres://localhost/portikus");
	expect(config.NODE_ENV).toBe("development");
	expect("SECRET_TOKEN" in config).toBe(false);
});

test("ignores process.env when an explicit environment is passed", () => {
	const previous = process.env.DATABASE_URL;
	process.env.DATABASE_URL = "postgres://localhost/from-process-env";
	try {
		const config = loadConfig(ApiConfigSchema, {
			DATABASE_URL: "postgres://localhost/explicit",
		});
		expect(config.DATABASE_URL).toBe("postgres://localhost/explicit");
	} finally {
		if (previous === undefined) {
			delete process.env.DATABASE_URL;
		} else {
			process.env.DATABASE_URL = previous;
		}
	}
});

// --- per-service config schemas ---

test("ApiConfig applies presence and quota defaults", () => {
	const config = loadConfig(ApiConfigSchema, {
		DATABASE_URL: "postgres://localhost/portikus",
	});
	expect(config.PRESENCE_TTL_SECONDS).toBe(60);
	expect(config.WORKSPACE_HOME_SIZE_GIB).toBe(25);
	expect(config.WORKSPACE_DOCKER_SIZE_GIB).toBe(20);
});

test("WorkerConfig lists missing DATABASE_URL", () => {
	try {
		loadConfig(WorkerConfigSchema, {});
		expect.unreachable("should have thrown");
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		expect((error as ConfigError).message).toContain("DATABASE_URL is missing");
	}
});

test("WorkerConfig applies all timer defaults", () => {
	const config = loadConfig(WorkerConfigSchema, {
		DATABASE_URL: "postgres://localhost/portikus",
	});
	expect(config.SHUTDOWN_GRACE_SECONDS).toBe(600);
	expect(config.SWEEP_INTERVAL_SECONDS).toBe(1);
	expect(config.START_TIMEOUT_SECONDS).toBe(60);
	expect(config.STOP_TIMEOUT_SECONDS).toBe(30);
	expect(config.STATUS_REFRESH_SECONDS).toBe(15);
	expect(config.PRESENCE_TTL_SECONDS).toBe(60);
});

test("ControllerConfig applies Incus defaults", () => {
	const config = loadConfig(ControllerConfigSchema, {});
	expect(config.PORT).toBe(3001);
	expect(config.INCUS_SOCKET).toBe("/var/lib/incus/unix.socket");
	expect(config.INCUS_PROJECT).toBe("portikus");
	expect(config.INCUS_POOL).toBe("workspace-data");
	expect(config.INCUS_PROFILE).toBe("workspace");
	expect(config.INCUS_IMAGE_ALIAS).toBe("portikus");
});

test("ControllerConfig rejects a short token in production", () => {
	try {
		loadConfig(ControllerConfigSchema, {
			NODE_ENV: "production",
			CONTROLLER_TOKEN: "short",
		});
		expect.unreachable("should have thrown");
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		expect((error as ConfigError).message).toContain("CONTROLLER_TOKEN");
	}
});

test("ControllerConfig accepts a long token in production", () => {
	const config = loadConfig(ControllerConfigSchema, {
		NODE_ENV: "production",
		CONTROLLER_TOKEN: "a".repeat(64),
	});
	expect(config.CONTROLLER_TOKEN).toBe("a".repeat(64));
});

test("ControllerConfig rejects the dev default token in production", () => {
	try {
		loadConfig(ControllerConfigSchema, { NODE_ENV: "production" });
		expect.unreachable("should have thrown");
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		expect((error as ConfigError).message).toContain("CONTROLLER_TOKEN");
	}
});

test("ControllerConfig rejects the dev token given explicitly in production", () => {
	try {
		loadConfig(ControllerConfigSchema, {
			NODE_ENV: "production",
			CONTROLLER_TOKEN: "dev-controller-token-not-for-production",
		});
		expect.unreachable("should have thrown");
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		expect((error as ConfigError).message).toContain("CONTROLLER_TOKEN");
	}
});

test("WorkerConfig rejects the dev default token in production", () => {
	try {
		loadConfig(WorkerConfigSchema, {
			NODE_ENV: "production",
			DATABASE_URL: "postgres://localhost/portikus",
		});
		expect.unreachable("should have thrown");
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		expect((error as ConfigError).message).toContain("CONTROLLER_TOKEN");
	}
});

test("WorkerConfig accepts a long non-default token in production", () => {
	const config = loadConfig(WorkerConfigSchema, {
		NODE_ENV: "production",
		DATABASE_URL: "postgres://localhost/portikus",
		CONTROLLER_TOKEN: "b".repeat(48),
	});
	expect(config.CONTROLLER_TOKEN).toBe("b".repeat(48));
});

test("ControllerConfig accepts the dev default token outside production", () => {
	const config = loadConfig(ControllerConfigSchema, {});
	expect(config.CONTROLLER_TOKEN).toBe("dev-controller-token-not-for-production");
});

test("timer seconds are coerced from strings", () => {
	const config = loadConfig(WorkerConfigSchema, {
		DATABASE_URL: "postgres://localhost/portikus",
		SHUTDOWN_GRACE_SECONDS: "120",
		SWEEP_INTERVAL_SECONDS: "2",
	});
	expect(config.SHUTDOWN_GRACE_SECONDS).toBe(120);
	expect(config.SWEEP_INTERVAL_SECONDS).toBe(2);
});
