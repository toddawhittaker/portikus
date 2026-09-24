import { expect, test } from "vitest";
import {
	AgentConfigSchema,
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

test("LOG_LEVEL defaults to info on every service", () => {
	expect(
		loadConfig(ApiConfigSchema, { DATABASE_URL: "postgres://localhost/portikus" })
			.LOG_LEVEL,
	).toBe("info");
	expect(loadConfig(AgentConfigSchema, {}).LOG_LEVEL).toBe("info");
});

test("an unknown LOG_LEVEL is a config error naming the variable", () => {
	try {
		loadConfig(ApiConfigSchema, {
			DATABASE_URL: "postgres://localhost/portikus",
			LOG_LEVEL: "verbose",
		});
		expect.unreachable("loadConfig should have thrown");
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		expect((error as ConfigError).issues[0]).toContain("LOG_LEVEL");
	}
});

test("PROJECT_TEMPLATES defaults to no templates", () => {
	const config = loadConfig(ApiConfigSchema, {
		DATABASE_URL: "postgres://localhost/portikus",
	});
	expect(config.projectTemplates).toEqual([]);
});

test("PROJECT_TEMPLATES is parsed into a list", () => {
	const config = loadConfig(ApiConfigSchema, {
		DATABASE_URL: "postgres://localhost/portikus",
		PROJECT_TEMPLATES:
			"Java=https://git.example/java.git,Py=https://git.example/py.git",
	});
	expect(config.projectTemplates).toEqual([
		{ name: "Java", url: "https://git.example/java.git" },
		{ name: "Py", url: "https://git.example/py.git" },
	]);
});

test("a malformed PROJECT_TEMPLATES entry is a config error", () => {
	try {
		loadConfig(ApiConfigSchema, {
			DATABASE_URL: "postgres://localhost/portikus",
			PROJECT_TEMPLATES: "Local=file:///tmp/x",
		});
		expect.unreachable("loadConfig should have thrown");
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		expect((error as ConfigError).issues[0]).toContain("PROJECT_TEMPLATES");
	}
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

test("SHUTDOWN_GRACE_SECONDS accepts zero, which means no shutdown", () => {
	const config = loadConfig(WorkerConfigSchema, {
		DATABASE_URL: "postgres://localhost/portikus",
		SHUTDOWN_GRACE_SECONDS: "0",
	});
	expect(config.SHUTDOWN_GRACE_SECONDS).toBe(0);
});

test("SHUTDOWN_GRACE_SECONDS rejects a negative value", () => {
	expect(() =>
		loadConfig(WorkerConfigSchema, {
			DATABASE_URL: "postgres://localhost/portikus",
			SHUTDOWN_GRACE_SECONDS: "-1",
		}),
	).toThrow();
});

// --- API auth and session configuration (SPEC.md §5.1, §5.3, §24) ---

const apiProdBase = {
	NODE_ENV: "production",
	DATABASE_URL: "postgres://localhost/portikus",
	PUBLIC_URL: "https://portikus.example.edu",
	OIDC_ISSUER_URL: "https://idp.example.edu",
	OIDC_CLIENT_SECRET: "c".repeat(48),
	SESSION_COOKIE_SECRET: "d".repeat(48),
	PREVIEW_SUFFIX: "preview.portikus.example.edu",
};

function expectConfigError(env: Record<string, string>, field: string): void {
	try {
		loadConfig(ApiConfigSchema, env);
		expect.unreachable("should have thrown");
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		expect((error as ConfigError).message).toContain(field);
	}
}

test("ApiConfig applies the auth and session defaults", () => {
	const config = loadConfig(ApiConfigSchema, {
		DATABASE_URL: "postgres://localhost/portikus",
	});
	expect(config.PUBLIC_URL).toBe("http://127.0.0.1:5173");
	expect(config.OIDC_ISSUER_URL).toBe("http://127.0.0.1:3002");
	expect(config.OIDC_CLIENT_ID).toBe("portikus-dev");
	expect(config.OIDC_CLIENT_SECRET).toBe("portikus-dev-secret");
	expect(config.OIDC_SCOPES).toBe("openid profile email");
	expect(config.OIDC_GROUPS_CLAIM).toBe("groups");
	expect(config.OIDC_STUDENT_GROUP).toBe("portikus-students");
	expect(config.OIDC_ADMIN_GROUP).toBe("portikus-administrators");
	expect(config.OIDC_INSTRUCTOR_GROUP).toBe("portikus-instructors");
	expect(config.SESSION_COOKIE_SECRET).toBe("dev-session-secret-not-for-production");
	expect(config.SESSION_TTL_SECONDS).toBe(43200);
});

test("ApiConfig rejects a PUBLIC_URL that is not a URL", () => {
	expectConfigError(
		{ DATABASE_URL: "postgres://localhost/portikus", PUBLIC_URL: "not-a-url" },
		"PUBLIC_URL",
	);
});

test("ApiConfig rejects an OIDC_ISSUER_URL that is not a URL", () => {
	expectConfigError(
		{
			DATABASE_URL: "postgres://localhost/portikus",
			OIDC_ISSUER_URL: "not-a-url",
		},
		"OIDC_ISSUER_URL",
	);
});

test("ApiConfig accepts a complete production environment", () => {
	const config = loadConfig(ApiConfigSchema, apiProdBase);
	expect(config.PUBLIC_URL).toBe("https://portikus.example.edu");
	expect(config.SESSION_TTL_SECONDS).toBe(43200);
});

test("ApiConfig requires https for PUBLIC_URL in production", () => {
	expectConfigError(
		{ ...apiProdBase, PUBLIC_URL: "http://portikus.example.edu" },
		"PUBLIC_URL",
	);
});

test("ApiConfig requires https for OIDC_ISSUER_URL in production", () => {
	expectConfigError(
		{ ...apiProdBase, OIDC_ISSUER_URL: "http://idp.example.edu" },
		"OIDC_ISSUER_URL",
	);
});

test("ApiConfig rejects the dev client secret in production", () => {
	expectConfigError(
		{ ...apiProdBase, OIDC_CLIENT_SECRET: "portikus-dev-secret" },
		"OIDC_CLIENT_SECRET",
	);
});

test("ApiConfig rejects a short client secret in production", () => {
	expectConfigError(
		{ ...apiProdBase, OIDC_CLIENT_SECRET: "short" },
		"OIDC_CLIENT_SECRET",
	);
});

test("ApiConfig rejects the dev session secret in production", () => {
	expectConfigError(
		{
			...apiProdBase,
			SESSION_COOKIE_SECRET: "dev-session-secret-not-for-production",
		},
		"SESSION_COOKIE_SECRET",
	);
});

test("ApiConfig rejects a short session secret in production", () => {
	expectConfigError(
		{ ...apiProdBase, SESSION_COOKIE_SECRET: "short" },
		"SESSION_COOKIE_SECRET",
	);
});

test("ApiConfig allows the dev secrets outside production", () => {
	const config = loadConfig(ApiConfigSchema, {
		DATABASE_URL: "postgres://localhost/portikus",
		NODE_ENV: "development",
	});
	expect(config.OIDC_CLIENT_SECRET).toBe("portikus-dev-secret");
});

test("ApiConfig coerces SESSION_TTL_SECONDS and rejects zero", () => {
	const config = loadConfig(ApiConfigSchema, {
		DATABASE_URL: "postgres://localhost/portikus",
		SESSION_TTL_SECONDS: "900",
	});
	expect(config.SESSION_TTL_SECONDS).toBe(900);
	expectConfigError(
		{ DATABASE_URL: "postgres://localhost/portikus", SESSION_TTL_SECONDS: "0" },
		"SESSION_TTL_SECONDS",
	);
});

test("AgentConfigSchema applies the workspace agent defaults", () => {
	const config = loadConfig(AgentConfigSchema, {});
	expect(config.PORT).toBe(7400);
	expect(config.TOKEN_PATH).toBe("/etc/portikus/agent.token");
	expect(config.HOME_DIR).toBe("/home/student");
});

test("AgentConfigSchema coerces an overridden PORT", () => {
	expect(loadConfig(AgentConfigSchema, { PORT: "7500" }).PORT).toBe(7500);
});

test("AGENT_PORT defaults to 7400 for the API, the worker, and the controller", () => {
	expect(
		loadConfig(ApiConfigSchema, { DATABASE_URL: "postgres://localhost/portikus" })
			.AGENT_PORT,
	).toBe(7400);
	expect(loadConfig(ControllerConfigSchema, {}).AGENT_PORT).toBe(7400);
	expect(
		loadConfig(WorkerConfigSchema, { DATABASE_URL: "postgres://localhost/portikus" })
			.AGENT_PORT,
	).toBe(7400);
});

// --- preview settings (BROWSER-HANDLING.md sections 8, 23) ---

const DB = { DATABASE_URL: "postgres://localhost/portikus" };

/** The environment a production API needs before the preview keys are added. */
const PROD = {
	...DB,
	NODE_ENV: "production",
	PUBLIC_URL: "https://portikus.school.edu",
	OIDC_ISSUER_URL: "https://idp.school.edu",
	OIDC_CLIENT_SECRET: "x".repeat(40),
	SESSION_COOKIE_SECRET: "y".repeat(40),
};

function issuesFor(env: Record<string, string>): readonly string[] {
	try {
		loadConfig(ApiConfigSchema, env);
		expect.unreachable("loadConfig should have thrown");
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		return (error as ConfigError).issues;
	}
	return [];
}

test("the preview settings have development defaults", () => {
	const config = loadConfig(ApiConfigSchema, DB);
	expect(config.PREVIEW_SUFFIX).toBe("preview.localhost");
	expect(config.PREVIEW_PORT_MIN).toBe(1024);
	expect(config.PREVIEW_PORT_MAX).toBe(65535);
	expect(config.PREVIEW_TICKET_TTL_SECONDS).toBe(30);
});

test("the denied preview ports always include the workspace agent port", () => {
	expect(loadConfig(ApiConfigSchema, DB).previewDeniedPorts).toEqual([
		22, 2375, 2376, 5432, 7400,
	]);
	expect(
		loadConfig(ApiConfigSchema, {
			...DB,
			PREVIEW_DENIED_PORTS: "9000, 9001",
			AGENT_PORT: "7500",
		}).previewDeniedPorts,
	).toEqual([7500, 9000, 9001]);
});

test("a denied port list that is not a port list is a config error", () => {
	expect(issuesFor({ ...DB, PREVIEW_DENIED_PORTS: "22,http" })[0]).toContain(
		"PREVIEW_DENIED_PORTS",
	);
	expect(issuesFor({ ...DB, PREVIEW_DENIED_PORTS: "70000" })[0]).toContain(
		"PREVIEW_DENIED_PORTS",
	);
});

test("production requires an explicit preview suffix", () => {
	expect(issuesFor(PROD)[0]).toContain("PREVIEW_SUFFIX");
	expect(
		loadConfig(ApiConfigSchema, {
			...PROD,
			PREVIEW_SUFFIX: "preview.portikus.school.edu",
		}).PREVIEW_SUFFIX,
	).toBe("preview.portikus.school.edu");
});

test("a malformed preview suffix is a config error", () => {
	for (const suffix of [
		"preview",
		"https://preview.school.edu",
		"preview.school.edu.",
		"preview.school.edu:8443",
		"-preview.school.edu",
		"preview..school.edu",
		"Preview.School.Edu",
		"preview.school.edu/x",
	]) {
		expect(issuesFor({ ...DB, PREVIEW_SUFFIX: suffix })[0]).toContain("PREVIEW_SUFFIX");
	}
});

test("the preview suffix must not cover the application host", () => {
	// Identical hosts share a browser origin, which the design forbids.
	expect(
		issuesFor({
			...DB,
			PUBLIC_URL: "https://preview.school.edu",
			PREVIEW_SUFFIX: "preview.school.edu",
		})[0],
	).toContain("PREVIEW_SUFFIX");

	// Wildcard routing under the suffix would otherwise accept the app host.
	expect(
		issuesFor({
			...DB,
			PUBLIC_URL: "https://portikus.preview.school.edu",
			PREVIEW_SUFFIX: "preview.school.edu",
		})[0],
	).toContain("PREVIEW_SUFFIX");

	// A sibling host under the same parent is fine.
	expect(
		loadConfig(ApiConfigSchema, {
			...DB,
			PUBLIC_URL: "https://portikus.school.edu",
			PREVIEW_SUFFIX: "preview.portikus.school.edu",
		}).PREVIEW_SUFFIX,
	).toBe("preview.portikus.school.edu");
});

test("the preview port range must be ordered and within 65535", () => {
	expect(
		issuesFor({ ...DB, PREVIEW_PORT_MIN: "9000", PREVIEW_PORT_MAX: "8000" })[0],
	).toContain("PREVIEW_PORT_MIN");
	expect(issuesFor({ ...DB, PREVIEW_PORT_MAX: "70000" })[0]).toContain(
		"PREVIEW_PORT_MAX",
	);
});

test("the worker config carries the preview suffix and checks its shape", () => {
	// The worker hands this to the controller, which writes it into every
	// workspace (issue #263).
	expect(
		loadConfig(WorkerConfigSchema, { DATABASE_URL: "postgres://x" }).PREVIEW_SUFFIX,
	).toBe("preview.localhost");
	expect(
		loadConfig(WorkerConfigSchema, {
			DATABASE_URL: "postgres://x",
			PREVIEW_SUFFIX: "preview.portikus.school.edu",
		}).PREVIEW_SUFFIX,
	).toBe("preview.portikus.school.edu");
	expect(() =>
		loadConfig(WorkerConfigSchema, {
			DATABASE_URL: "postgres://x",
			PREVIEW_SUFFIX: "https://preview.school.edu",
		}),
	).toThrow(/PREVIEW_SUFFIX/);
});

// --- recovery points (SPEC.md §15, §19.1; ADR 0020) ---

test("WorkerConfig applies the recovery defaults", () => {
	const config = loadConfig(WorkerConfigSchema, {
		DATABASE_URL: "postgres://localhost/portikus",
	});
	expect(config.WORKSPACE_RECOVERY_SIZE_GIB).toBe(3);
	expect(config.RECOVERY_INTERVAL_SECONDS).toBe(900);
	expect(config.RECOVERY_RETENTION_DAYS).toBe(14);
	expect(config.RECOVERY_SWEEP_SECONDS).toBe(60);
});

test("ApiConfig applies the recovery defaults", () => {
	const config = loadConfig(ApiConfigSchema, {
		DATABASE_URL: "postgres://localhost/portikus",
	});
	expect(config.WORKSPACE_RECOVERY_SIZE_GIB).toBe(3);
	expect(config.RECOVERY_RETENTION_DAYS).toBe(14);
});

test("ApiConfig's sign-in limits let a lab of 30 behind one address sign in within a minute", () => {
	const config = loadConfig(ApiConfigSchema, {
		DATABASE_URL: "postgres://localhost/portikus",
	});
	// One sign-in takes five starts: /auth/login, three /dex/auth pages, /auth/callback.
	expect(config.SIGNIN_START_LIMIT_PER_MINUTE).toBe(150);
	expect(config.PASSWORD_ATTEMPT_LIMIT_PER_10_MINUTES).toBe(30);
});

test("AgentConfig defaults RECOVERY_ROOT to the recovery volume mount", () => {
	const config = loadConfig(AgentConfigSchema, {});
	expect(config.RECOVERY_ROOT).toBe("/var/lib/portikus/recovery");
});

test("a zero recovery interval is a config error", () => {
	expect(() =>
		loadConfig(WorkerConfigSchema, {
			DATABASE_URL: "postgres://localhost/portikus",
			RECOVERY_INTERVAL_SECONDS: "0",
		}),
	).toThrow(/RECOVERY_INTERVAL_SECONDS/);
});

// --- Sign-in provider settings (docs/EPIC-14.md, "API settings") ---

const apiDevBase = { DATABASE_URL: "postgres://localhost/portikus" };

test("ApiConfig defaults to generic OIDC, no default role, no proxy, no Dex gRPC", () => {
	const config = loadConfig(ApiConfigSchema, apiDevBase);
	expect(config.OIDC_PROVIDER).toBe("oidc");
	expect(config.OIDC_DEFAULT_ROLE).toBe("none");
	expect(config.OIDC_ALLOWED_TENANT).toBeUndefined();
	expect(config.oidcAllowedDomains).toEqual([]);
	expect(config.OUTBOUND_PROXY_URL).toBeUndefined();
	expect(config.DEX_GRPC_ADDR).toBeUndefined();
});

test("ApiConfig refuses entra without a tenant", () => {
	expectConfigError({ ...apiDevBase, OIDC_PROVIDER: "entra" }, "OIDC_ALLOWED_TENANT");
});

test("ApiConfig accepts entra with a tenant", () => {
	const config = loadConfig(ApiConfigSchema, {
		...apiDevBase,
		OIDC_PROVIDER: "entra",
		OIDC_ALLOWED_TENANT: "11111111-2222-3333-4444-555555555555",
	});
	expect(config.OIDC_ALLOWED_TENANT).toBe("11111111-2222-3333-4444-555555555555");
});

test("ApiConfig refuses google without domains", () => {
	expectConfigError({ ...apiDevBase, OIDC_PROVIDER: "google" }, "OIDC_ALLOWED_DOMAINS");
	expectConfigError(
		{ ...apiDevBase, OIDC_PROVIDER: "google", OIDC_ALLOWED_DOMAINS: " , " },
		"OIDC_ALLOWED_DOMAINS",
	);
});

test("ApiConfig parses google domains, trimmed and lowercased", () => {
	const config = loadConfig(ApiConfigSchema, {
		...apiDevBase,
		OIDC_PROVIDER: "google",
		OIDC_ALLOWED_DOMAINS: "School.edu, staff.school.edu",
	});
	expect(config.oidcAllowedDomains).toEqual(["school.edu", "staff.school.edu"]);
});

test("ApiConfig refuses a domain that is not a DNS name", () => {
	expectConfigError(
		{
			...apiDevBase,
			OIDC_PROVIDER: "google",
			OIDC_ALLOWED_DOMAINS: "https://school.edu",
		},
		"OIDC_ALLOWED_DOMAINS",
	);
});

test("ApiConfig refuses an unknown provider or default role", () => {
	expectConfigError({ ...apiDevBase, OIDC_PROVIDER: "saml" }, "OIDC_PROVIDER");
	expectConfigError(
		{ ...apiDevBase, OIDC_DEFAULT_ROLE: "instructor" },
		"OIDC_DEFAULT_ROLE",
	);
});

test("ApiConfig accepts a proxy URL and refuses one that is not a URL", () => {
	const config = loadConfig(ApiConfigSchema, {
		...apiDevBase,
		OUTBOUND_PROXY_URL: "http://127.0.0.1:3128",
	});
	expect(config.OUTBOUND_PROXY_URL).toBe("http://127.0.0.1:3128");
	expectConfigError(
		{ ...apiDevBase, OUTBOUND_PROXY_URL: "squid" },
		"OUTBOUND_PROXY_URL",
	);
});

test("ApiConfig requires the Dex gRPC settings together", () => {
	expectConfigError(
		{ ...apiDevBase, DEX_GRPC_ADDR: "127.0.0.1:5557" },
		"DEX_GRPC_ADDR",
	);
	const config = loadConfig(ApiConfigSchema, {
		...apiDevBase,
		DEX_GRPC_ADDR: "127.0.0.1:5557",
		DEX_GRPC_CA: "/etc/portikus/dex-grpc/ca.crt",
		DEX_GRPC_CERT: "/etc/portikus/dex-grpc/client.crt",
		DEX_GRPC_KEY: "/etc/portikus/dex-grpc/client.key",
	});
	expect(config.DEX_GRPC_ADDR).toBe("127.0.0.1:5557");
});
