/**
 * The workspace image job's shapes (docs/SPEC.md section 22.4).
 * A request carries nothing but a fixed kind, fixed choices and a strictly
 * shaped version, because the job that reads it runs as root.
 */
import { describe, expect, test } from "vitest";
import {
	compareImageVersions,
	ImageAliasesFile,
	ImageHealth,
	ImageJobRequest,
	ImageJobStatusFile,
	ImageManifest,
	ImageVersion,
	newerPublishedImage,
	PublishedReleasesFile,
} from "./image.js";

const ID = "550e8400-e29b-41d4-a716-446655440000";

describe("ImageVersion", () => {
	test.each(["2026.09.9", "2026.10.12", "2026.09.9-local.202609281530"])(
		"accepts %s",
		(version) => {
			expect(ImageVersion.safeParse(version).success).toBe(true);
		},
	);

	test.each([
		"",
		"latest",
		"26.09.9",
		"2026.9.9",
		"2026.09",
		"2026.09.9-local",
		"2026.09.9-local.2026092815",
		"2026.09.9-dev.202609281530",
		"2026.09.9;rm -rf /",
		"2026.09.9\n",
		"../2026.09.9",
		" 2026.09.9",
	])("refuses %j", (version) => {
		expect(ImageVersion.safeParse(version).success).toBe(false);
	});
});

describe("ImageJobRequest", () => {
	test.each([
		{ kind: "fetch" },
		{ kind: "fetch", version: "2026.10.1" },
		{ kind: "build", node: "24", python: "debian" },
		{ kind: "build", node: "26", python: "uv-3.14" },
		{ kind: "activate", version: "2026.09.9-local.202609281530" },
		{ kind: "rollback" },
	])("accepts %j", (body) => {
		expect(ImageJobRequest.safeParse(body).success).toBe(true);
	});

	test.each([
		{},
		{ kind: "delete" },
		{ kind: "shell", command: "id" },
		{ kind: "fetch", version: "latest" },
		{ kind: "build", node: "22", python: "debian" },
		{ kind: "build", node: 24, python: "debian" },
		{ kind: "build", node: "24", python: "3.12" },
		{ kind: "build", node: "24" },
		{ kind: "build", node: "24", python: "debian", packages: ["curl"] },
		{ kind: "activate" },
		{ kind: "activate", version: "2026.09.9 && id" },
		{ kind: "rollback", version: "2026.09.9" },
	])("refuses %j", (body) => {
		expect(ImageJobRequest.safeParse(body).success).toBe(false);
	});
});

describe("the files the root job writes", () => {
	test("a status file never says queued", () => {
		const status = {
			id: ID,
			kind: "fetch",
			state: "running",
			step: "Downloading",
			version: null,
			message: null,
			startedAt: "2026-09-28T10:00:00Z",
			finishedAt: null,
		};
		expect(ImageJobStatusFile.safeParse(status).success).toBe(true);
		expect(ImageJobStatusFile.safeParse({ ...status, state: "queued" }).success).toBe(
			false,
		);
	});

	test("aliases name a version or nothing", () => {
		expect(ImageAliasesFile.parse({ default: "2026.09.9", previous: null })).toEqual({
			default: "2026.09.9",
			previous: null,
		});
		expect(ImageAliasesFile.safeParse({ default: "x", previous: null }).success).toBe(
			false,
		);
	});

	test("a manifest carries packages, tools, parameters and source", () => {
		const manifest = {
			schema: 1,
			version: "2026.09.9",
			recipeVersion: "2026.09.9",
			source: "published",
			builtAt: "2026-09-20T10:00:00Z",
			fingerprint: null,
			parameters: { node: "24", python: "debian" },
			tools: {
				node: "v24.8.0",
				npm: "11.6.0",
				python3: "Python 3.13.5",
				git: "git version 2.47.3",
				docker: "Docker version 28.4.0",
				claude: "2.0.1 (Claude Code)",
				codex: null,
			},
			packages: { "libc6:amd64": "2.41-12", git: "1:2.47.3-0+deb13u1" },
		};
		expect(ImageManifest.safeParse(manifest).success).toBe(true);
		expect(ImageManifest.safeParse({ ...manifest, source: "other" }).success).toBe(
			false,
		);
		expect(
			ImageManifest.safeParse({ ...manifest, tools: { node: "v24" } }).success,
		).toBe(false);
	});

	test("a health result is passed or failed", () => {
		const health = { result: "passed", checkedAt: "2026-09-28T10:00:00Z", checks: [] };
		expect(ImageHealth.safeParse(health).success).toBe(true);
		expect(ImageHealth.safeParse({ ...health, result: "ok" }).success).toBe(false);
	});
});

describe("compareImageVersions", () => {
	test("orders by year, month and serial as numbers", () => {
		expect(compareImageVersions("2026.09.13", "2026.09.9")).toBeGreaterThan(0);
		expect(compareImageVersions("2026.10.1", "2026.09.13")).toBeGreaterThan(0);
		expect(compareImageVersions("2027.01.1", "2026.12.40")).toBeGreaterThan(0);
		expect(compareImageVersions("2026.09.9", "2026.09.9")).toBe(0);
	});

	test("a local build sorts after its published version and before the next", () => {
		const local = "2026.09.12-local.202609281530";
		expect(compareImageVersions(local, "2026.09.12")).toBeGreaterThan(0);
		expect(compareImageVersions("2026.09.13", local)).toBeGreaterThan(0);
		expect(compareImageVersions(local, "2026.09.12-local.202609281531")).toBeLessThan(
			0,
		);
	});
});

describe("newerPublishedImage", () => {
	test("names a published image newer than every image on the server", () => {
		expect(newerPublishedImage("2026.09.13", ["2026.09.12", "2026.09.9"])).toBe(
			"2026.09.13",
		);
		expect(newerPublishedImage("2026.09.13", [])).toBe("2026.09.13");
	});

	test("is null once that version or a newer one is on the server", () => {
		expect(newerPublishedImage("2026.09.13", ["2026.09.13", "2026.09.12"])).toBeNull();
		expect(
			newerPublishedImage("2026.09.13", ["2026.09.13-local.202609290000"]),
		).toBeNull();
		expect(newerPublishedImage(null, ["2026.09.12"])).toBeNull();
	});
});

describe("PublishedReleasesFile", () => {
	const checkedAt = "2026-09-29T04:00:00.000Z";

	test("accepts what image-job check writes", () => {
		expect(
			PublishedReleasesFile.safeParse({
				checkedAt,
				image: "2026.09.13",
				package: { installed: "0.1.695", available: "0.1.700" },
			}).success,
		).toBe(true);
		expect(
			PublishedReleasesFile.safeParse({ checkedAt, image: null, package: null })
				.success,
		).toBe(true);
	});

	test("rejects an image that is not an image version", () => {
		expect(
			PublishedReleasesFile.safeParse({ checkedAt, image: "../etc", package: null })
				.success,
		).toBe(false);
	});
});
