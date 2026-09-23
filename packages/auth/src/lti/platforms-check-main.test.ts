import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

const main = fileURLToPath(new URL("./platforms-check-main.ts", import.meta.url));
let dir: string;

function run(args: string[]) {
	return spawnSync(process.execPath, ["--import", "tsx", main, ...args], {
		encoding: "utf8",
	});
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "lti-check-"));
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("accepts a good file", async () => {
	const path = join(dir, "good.json");
	await writeFile(
		path,
		JSON.stringify({
			version: 1,
			platforms: [
				{
					name: "Canvas",
					issuer: "https://canvas.example.edu",
					clientId: "1",
					authLoginUrl: "https://canvas.example.edu/auth",
					keysetUrl: "https://canvas.example.edu/jwks",
					deploymentIds: ["d1"],
					mock: false,
				},
			],
		}),
	);
	const r = run([path]);
	expect(r.stderr).toBe("");
	expect(r.status).toBe(0);
});

test("refuses an empty platforms list and names the problem", async () => {
	const path = join(dir, "empty.json");
	await writeFile(path, JSON.stringify({ version: 1, platforms: [] }));
	const r = run([path]);
	expect(r.status).toBe(1);
	expect(r.stderr).toMatch(/^LTI platforms file: platforms: /);
});

test("refuses a missing file", () => {
	const r = run([join(dir, "missing.json")]);
	expect(r.status).toBe(1);
	expect(r.stderr).toContain("cannot read (ENOENT)");
});

test("refuses to run without a path", () => {
	const r = run([]);
	expect(r.status).toBe(2);
	expect(r.stderr).toContain("usage:");
});
