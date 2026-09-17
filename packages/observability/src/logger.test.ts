import { expect, test } from "vitest";
import { LOG_LEVELS, silentLogger } from "./logger.js";
import { collectingLogger, lineAt } from "./testing.js";

test("every line carries the service, a level label, an ISO time and a message", () => {
	const { logger, lines } = collectingLogger();
	logger.info({ workspaceId: "w1" }, "hello");
	expect(lines).toHaveLength(1);
	const line = lineAt(lines, 0);
	expect(line.service).toBe("test");
	expect(line.level).toBe("info");
	expect(typeof line.time).toBe("string");
	expect(new Date(line.time as string).toISOString()).toBe(line.time);
	expect(line.msg).toBe("hello");
	expect(line.workspaceId).toBe("w1");
	expect(line.pid).toBeUndefined();
	expect(line.hostname).toBeUndefined();
});

test("a debug line is dropped at info and kept at debug", () => {
	const quiet = collectingLogger("info");
	quiet.logger.debug("quiet");
	expect(quiet.lines).toHaveLength(0);

	const loud = collectingLogger("debug");
	loud.logger.debug("loud");
	expect(loud.lines).toHaveLength(1);
});

test("secrets are redacted wherever they appear", () => {
	const { logger, lines } = collectingLogger();
	logger.info(
		{
			headers: { authorization: "Bearer abc", cookie: "session=xyz" },
			req: { headers: { authorization: "Bearer abc", cookie: "session=xyz" } },
			outer: { headers: { authorization: "Bearer abc", cookie: "session=xyz" } },
			token: "plain",
			agentToken: "plain",
			clientSecret: "plain",
			nested: { token: "plain", agentToken: "plain", clientSecret: "plain" },
		},
		"secrets",
	);
	const text = JSON.stringify(lineAt(lines, 0));
	expect(text).not.toContain("Bearer abc");
	expect(text).not.toContain("session=xyz");
	expect(text).not.toContain("plain");
	expect(text).toContain("[redacted]");
});

test("the silent logger writes nothing", () => {
	const logger = silentLogger();
	expect(() => logger.error("boom")).not.toThrow();
});

test("the level list is loudest first", () => {
	expect(LOG_LEVELS).toEqual(["error", "warn", "info", "debug"]);
});

test("a token nested inside a row or an error object is redacted", () => {
	const { logger, lines } = collectingLogger();
	logger.info({ row: { agent_token: "secret-one" } }, "row");
	logger.info(
		{ err: { request: { headers: { authorization: "Bearer secret-two" } } } },
		"err",
	);
	const text = JSON.stringify(lines);
	expect(text).not.toContain("secret-one");
	expect(text).not.toContain("secret-two");
	expect(text).toContain("[redacted]");
});
