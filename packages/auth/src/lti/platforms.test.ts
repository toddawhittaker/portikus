import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	findPlatform,
	type LtiPlatform,
	loadPlatformsFile,
	PlatformsFileError,
	parsePlatformsFile,
} from "./platforms.js";

const canvas: LtiPlatform = {
	name: "Canvas",
	issuer: "https://canvas.instructure.com",
	clientId: "10000000000001",
	authLoginUrl: "https://sso.canvaslms.com/api/lti/authorize_redirect",
	keysetUrl: "https://sso.canvaslms.com/api/lti/security/jwks",
	deploymentIds: ["1:abc"],
	mock: false,
};

function file(...platforms: unknown[]): unknown {
	return { version: 1, platforms };
}

function problem(data: unknown): string {
	try {
		parsePlatformsFile(data);
	} catch (error) {
		expect(error).toBeInstanceOf(PlatformsFileError);
		return (error as Error).message;
	}
	throw new Error("expected the file to be refused");
}

describe("parsePlatformsFile", () => {
	test("accepts the brief's example and an empty list", () => {
		expect(parsePlatformsFile(file(canvas))).toEqual([canvas]);
		expect(parsePlatformsFile(file())).toEqual([]);
	});

	test("accepts two registrations sharing an issuer with different client ids", () => {
		const second = { ...canvas, name: "Canvas 2", clientId: "2" };
		expect(parsePlatformsFile(file(canvas, second))).toHaveLength(2);
	});

	test("allows http only for a mock registration", () => {
		const mock = {
			...canvas,
			name: "mock-lms",
			issuer: "http://10.100.0.1:8765",
			authLoginUrl: "http://10.100.0.1:8765/authorize",
			keysetUrl: "http://10.100.0.1:8765/.well-known/jwks.json",
			mock: true,
		};
		expect(parsePlatformsFile(file(mock))).toEqual([mock]);
	});

	test.each([
		["a wrong version", { version: 2, platforms: [] }, "version"],
		["no platforms key", { version: 1 }, "platforms"],
		["an unknown top-level key", { version: 1, platforms: [], extra: 1 }, "extra"],
		["an unknown platform key", file({ ...canvas, secret: "x" }), "secret"],
		["an empty name", file({ ...canvas, name: "" }), "platforms.0.name"],
		["a long name", file({ ...canvas, name: "x".repeat(61) }), "platforms.0.name"],
		["a non-URL issuer", file({ ...canvas, issuer: "canvas" }), "platforms.0.issuer"],
		["an empty client id", file({ ...canvas, clientId: "" }), "platforms.0.clientId"],
		["a bad authLoginUrl", file({ ...canvas, authLoginUrl: "nope" }), "authLoginUrl"],
		["a bad keysetUrl", file({ ...canvas, keysetUrl: "nope" }), "keysetUrl"],
		["no deployment ids", file({ ...canvas, deploymentIds: [] }), "deploymentIds"],
		[
			"an empty deployment id",
			file({ ...canvas, deploymentIds: [""] }),
			"deploymentIds",
		],
		["a missing mock flag", file({ ...canvas, mock: undefined }), "mock"],
		[
			"an http issuer without mock",
			file({ ...canvas, issuer: "http://canvas.example.edu" }),
			"platforms.0.issuer: must be an https URL",
		],
		[
			"an http authLoginUrl without mock",
			file({ ...canvas, authLoginUrl: "http://sso.example.edu/a" }),
			"platforms.0.authLoginUrl",
		],
		[
			"an http keysetUrl without mock",
			file({ ...canvas, keysetUrl: "http://sso.example.edu/k" }),
			"platforms.0.keysetUrl",
		],
		[
			"a non-web scheme even for a mock",
			file({ ...canvas, keysetUrl: "file:///etc/passwd", mock: true }),
			"platforms.0.keysetUrl",
		],
		[
			"a duplicate name",
			file(canvas, { ...canvas, clientId: "2" }),
			'platforms.1.name: duplicate name "Canvas"',
		],
		[
			"a duplicate issuer and client id",
			file(canvas, { ...canvas, name: "Other" }),
			"platforms.1: duplicate issuer and clientId",
		],
	])("refuses %s", (_label, data, expected) => {
		expect(problem(data)).toContain(expected);
	});
});

describe("loadPlatformsFile", () => {
	let dir: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "lti-platforms-"));
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("reads a good file", async () => {
		const path = join(dir, "good.json");
		await writeFile(path, JSON.stringify(file(canvas)));
		expect(await loadPlatformsFile(path)).toEqual([canvas]);
	});

	test("names a missing file", async () => {
		await expect(loadPlatformsFile(join(dir, "missing.json"))).rejects.toThrow(
			/cannot read \(ENOENT\)/,
		);
	});

	test("names bad JSON", async () => {
		const path = join(dir, "bad.json");
		await writeFile(path, "{");
		await expect(loadPlatformsFile(path)).rejects.toThrow(/not valid JSON/);
	});
});

describe("findPlatform", () => {
	const second = { ...canvas, name: "Canvas 2", clientId: "2" };
	const moodle = { ...canvas, name: "Moodle", issuer: "https://moodle.example.edu" };

	test("finds by issuer and client id", () => {
		expect(findPlatform([canvas, second], canvas.issuer, "2")).toBe(second);
	});

	test("uses the only registration when client id is absent", () => {
		expect(findPlatform([canvas, moodle], moodle.issuer, undefined)).toBe(moodle);
	});

	test("refuses an absent client id when the issuer has several", () => {
		expect(findPlatform([canvas, second], canvas.issuer, undefined)).toBeNull();
	});

	test("refuses an unknown pair", () => {
		expect(findPlatform([canvas], canvas.issuer, "nope")).toBeNull();
		expect(
			findPlatform([canvas], "https://evil.example.com", canvas.clientId),
		).toBeNull();
	});
});
