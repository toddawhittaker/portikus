import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const main = fileURLToPath(new URL("./carry-over-main.ts", import.meta.url));

function run(args: string[], env: Record<string, string | undefined> = {}) {
	return spawnSync(process.execPath, ["--import", "tsx", main, ...args], {
		encoding: "utf8",
		env: { ...process.env, DATABASE_URL: undefined, ...env },
	});
}

test("refuses to run without --input", () => {
	const r = run(["--apply"]);
	expect(r.status).toBe(2);
	expect(r.stderr).toContain("--input is required");
});

test("refuses an unknown argument", () => {
	const r = run(["--input", "x.json", "--force"]);
	expect(r.status).toBe(2);
	expect(r.stderr).toContain("unknown argument: --force");
});

test("refuses to run without DATABASE_URL", () => {
	const r = run(["--input", "x.json"]);
	expect(r.status).toBe(2);
	expect(r.stderr).toContain("DATABASE_URL is not set");
});
