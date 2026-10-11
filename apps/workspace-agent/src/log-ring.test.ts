import { Writable } from "node:stream";
import { createLogger } from "@portikus/observability";
import { expect, test } from "vitest";
import { LogRing, teeToRing } from "./log-ring.js";

const line = (fields: Record<string, unknown>) =>
	JSON.stringify({
		time: "2026-10-10T00:00:00.000Z",
		level: "warn",
		msg: "m",
		...fields,
	});

test("keeps warn and above only", () => {
	const ring = new LogRing();
	for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
		ring.push(line({ level, msg: level }));
	}
	expect(ring.lines().map((l) => l.msg)).toEqual(["warn", "error", "fatal"]);
});

test("drops every field outside the allowlist", () => {
	const ring = new LogRing();
	ring.push(
		line({
			name: "secret-project",
			path: "/home/student/secret-project/a.ts",
			service: "workspace-agent",
			code: "E_X",
			status: 500,
			durationMs: 12,
		}),
	);
	expect(ring.lines()).toEqual([
		{
			time: "2026-10-10T00:00:00.000Z",
			level: "warn",
			msg: "m",
			code: "E_X",
			status: 500,
			durationMs: 12,
		},
	]);
});

test("ignores lines that are not JSON or have the wrong field types", () => {
	const ring = new LogRing();
	ring.push("not json");
	ring.push(line({ msg: 42 }));
	ring.push(line({ status: "500", code: 3 }));
	expect(ring.lines()).toEqual([
		{ time: "2026-10-10T00:00:00.000Z", level: "warn", msg: "m" },
	]);
});

test("keeps only the last lines up to the line cap", () => {
	const ring = new LogRing(3);
	for (let i = 0; i < 10; i++) ring.push(line({ msg: `n${i}` }));
	expect(ring.lines().map((l) => l.msg)).toEqual(["n7", "n8", "n9"]);
});

test("the default caps are 200 lines and 128 KiB", () => {
	const ring = new LogRing();
	for (let i = 0; i < 500; i++) ring.push(line({ msg: `n${i}` }));
	expect(ring.lines()).toHaveLength(200);

	const big = new LogRing();
	const msg = "x".repeat(10 * 1024);
	for (let i = 0; i < 50; i++) big.push(line({ msg }));
	const bytes = big
		.lines()
		.reduce((sum, l) => sum + Buffer.byteLength(JSON.stringify(l)), 0);
	expect(bytes).toBeLessThanOrEqual(128 * 1024);
	expect(big.lines().length).toBe(12);
});

test("a single line past the byte cap is not kept", () => {
	const ring = new LogRing(200, 100);
	ring.push(line({ msg: "x".repeat(200) }));
	expect(ring.lines()).toEqual([]);
});

test("the tee passes every line on and feeds the ring from a real logger", () => {
	const ring = new LogRing();
	const written: string[] = [];
	const out = new Writable({
		write(chunk, _encoding, callback) {
			written.push(chunk.toString());
			callback();
		},
	});
	const logger = createLogger({
		service: "workspace-agent",
		level: "info",
		destination: teeToRing(ring, out),
	});
	logger.info({ name: "p" }, "hello");
	logger.warn({ name: "p", code: "C" }, "careful");
	expect(written).toHaveLength(2);
	expect(ring.lines()).toEqual([
		expect.objectContaining({ level: "warn", msg: "careful", code: "C" }),
	]);
	expect(ring.lines()[0]).not.toHaveProperty("name");
	expect(ring.lines()[0]).not.toHaveProperty("service");
});
