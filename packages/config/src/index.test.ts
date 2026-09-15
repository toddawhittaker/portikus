import { expect, test } from "vitest";
import { ConfigError, loadConfig } from "./index.js";

test("applies defaults and coerces PORT", () => {
	const config = loadConfig({
		DATABASE_URL: "postgres://localhost/portikus",
		PORT: "8080",
	});
	expect(config).toEqual({
		NODE_ENV: "development",
		PORT: 8080,
		DATABASE_URL: "postgres://localhost/portikus",
	});
});

test("lists every missing variable in the error message", () => {
	try {
		loadConfig({});
		expect.unreachable("loadConfig should have thrown");
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		expect((error as ConfigError).issues).toEqual(["DATABASE_URL is missing"]);
		expect((error as ConfigError).message).toContain("DATABASE_URL is missing");
	}
});

test("reports a value that is present but invalid", () => {
	try {
		loadConfig({ DATABASE_URL: "postgres://localhost/portikus", PORT: "-1" });
		expect.unreachable("loadConfig should have thrown");
	} catch (error) {
		expect((error as ConfigError).issues[0]).toContain("PORT");
	}
});

test("names every failing variable when more than one is wrong", () => {
	try {
		loadConfig({ PORT: "not-a-number" });
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
		loadConfig({ DATABASE_URL: "postgres://localhost/portikus", PORT: "abc" });
		expect.unreachable("loadConfig should have thrown");
	} catch (error) {
		const issues = (error as ConfigError).issues;
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatch(/^PORT /);
		expect(issues[0]).not.toContain("is missing");
	}
});

test("reads only the variables in the schema", () => {
	const config = loadConfig({
		DATABASE_URL: "postgres://localhost/portikus",
		SECRET_TOKEN: "do-not-leak",
		HOME: "/home/someone",
	});
	expect(Object.keys(config).sort()).toEqual(["DATABASE_URL", "NODE_ENV", "PORT"]);
});

test("ignores process.env when an explicit environment is passed", () => {
	const previous = process.env.DATABASE_URL;
	process.env.DATABASE_URL = "postgres://localhost/from-process-env";
	try {
		const config = loadConfig({ DATABASE_URL: "postgres://localhost/explicit" });
		expect(config.DATABASE_URL).toBe("postgres://localhost/explicit");
	} finally {
		if (previous === undefined) {
			delete process.env.DATABASE_URL;
		} else {
			process.env.DATABASE_URL = previous;
		}
	}
});
