/**
 * The page-registered platforms join the operator's at start (ADR 0059): a
 * bad page file never stops the API, and the operator's file wins a clash.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { loadLtiDeps } from "./deps.js";

const operator = {
	name: "Operator LMS",
	issuer: "https://op.example.edu",
	clientId: "op-client",
	authLoginUrl: "https://op.example.edu/auth",
	keysetUrl: "https://op.example.edu/jwks",
	deploymentIds: ["d1"],
	mock: false,
};
const added = {
	name: "Canvas",
	issuer: "https://canvas.example.edu",
	clientId: "c1",
	authLoginUrl: "https://canvas.example.edu/auth",
	keysetUrl: "https://canvas.example.edu/jwks",
	authTokenUrl: "https://canvas.example.edu/token",
	deploymentIds: ["d2"],
	mock: false,
};

let dir = "";
let operatorFile = "";
let pageFile = "";
let skipped: string[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "lti-deps-"));
	operatorFile = join(dir, "operator.json");
	pageFile = join(dir, "page.json");
	skipped = [];
	await writeFile(operatorFile, JSON.stringify({ version: 1, platforms: [operator] }));
});

const load = () =>
	loadLtiDeps(
		{ LTI_PLATFORMS_FILE: operatorFile, LTI_ADMIN_PLATFORMS_FILE: pageFile },
		(message) => skipped.push(message),
	);

describe("merging the page platforms file", () => {
	test("page platforms follow the operator's, in a plain array", async () => {
		await writeFile(pageFile, JSON.stringify({ version: 1, platforms: [added] }));
		const lti = await load();
		expect(Array.isArray(lti?.platforms)).toBe(true);
		expect(lti?.platforms).toEqual([operator, added]);
		expect(skipped).toEqual([]);
	});

	test("no page file means the operator's platforms alone", async () => {
		expect((await load())?.platforms).toEqual([operator]);
		expect(skipped).toEqual([]);
	});

	test("a page file that is wrong is skipped and reported, and the API starts", async () => {
		for (const text of [
			"not json",
			JSON.stringify({ version: 2, platforms: [added] }),
			JSON.stringify({ version: 1, platforms: [{ ...added, extra: true }] }),
		]) {
			skipped = [];
			await writeFile(pageFile, text);
			expect((await load())?.platforms).toEqual([operator]);
			expect(skipped).toHaveLength(1);
		}
	});

	test("a mock platform in the page file is not enabled", async () => {
		await writeFile(
			pageFile,
			JSON.stringify({ version: 1, platforms: [{ ...added, mock: true }] }),
		);
		expect((await load())?.platforms).toEqual([operator]);
	});

	test("an entry that repeats an operator name or pair is dropped", async () => {
		await writeFile(
			pageFile,
			JSON.stringify({
				version: 1,
				platforms: [
					{ ...added, name: operator.name },
					{
						...added,
						name: "Same pair",
						issuer: operator.issuer,
						clientId: operator.clientId,
					},
					{ ...added, name: "Fine", clientId: "c2" },
				],
			}),
		);
		const names = (await load())?.platforms.map((p) => p.name);
		expect(names).toEqual(["Operator LMS", "Fine"]);
	});

	test("with no operator file the page platforms alone turn LTI on", async () => {
		await writeFile(pageFile, JSON.stringify({ version: 1, platforms: [added] }));
		const lti = await loadLtiDeps({
			LTI_PLATFORMS_FILE: join(dir, "missing.json"),
			LTI_ADMIN_PLATFORMS_FILE: pageFile,
		});
		expect(lti?.platforms).toEqual([added]);
	});

	test("LTI is off only when neither file holds a platform", async () => {
		const missing = join(dir, "missing.json");
		expect(
			await loadLtiDeps({
				LTI_PLATFORMS_FILE: missing,
				LTI_ADMIN_PLATFORMS_FILE: pageFile,
			}),
		).toBeUndefined();
		await writeFile(pageFile, JSON.stringify({ version: 1, platforms: [] }));
		expect(
			await loadLtiDeps({
				LTI_PLATFORMS_FILE: missing,
				LTI_ADMIN_PLATFORMS_FILE: pageFile,
			}),
		).toBeUndefined();
	});

	test("a page entry naming a registered issuer with another key set is skipped and reported", async () => {
		await writeFile(
			pageFile,
			JSON.stringify({
				version: 1,
				platforms: [
					{
						...added,
						name: "Impostor",
						issuer: operator.issuer,
						clientId: "other-client",
						keysetUrl: "https://evil.example.com/jwks",
					},
					{
						...added,
						name: "Second Canvas",
						clientId: "c2",
						keysetUrl: "https://x.example/jwks",
					},
					added,
					{ ...added, name: "Canvas again", clientId: "c3" },
					{
						...added,
						name: "Operator twin",
						clientId: "c4",
						issuer: operator.issuer,
						keysetUrl: operator.keysetUrl,
					},
				],
			}),
		);
		const names = (await load())?.platforms.map((p) => p.name);
		expect(names).toEqual(["Operator LMS", "Second Canvas", "Operator twin"]);
		expect(skipped).toHaveLength(3);
		expect(skipped.join(" ")).toContain("Impostor");
	});
});
