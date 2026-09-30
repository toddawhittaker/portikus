import { OTHER_IMAGES_LABEL } from "@portikus/contracts";
import { expect, test } from "vitest";
import {
	addRefusal,
	cacheUseText,
	credentialErrors,
	listHas,
	parseSeedMaxGiB,
	seedListError,
	shortImageName,
} from "./text.js";

test("short names drop only the Docker Hub prefix", () => {
	expect(shortImageName("docker.io/library/redis:7")).toBe("redis:7");
	expect(shortImageName("docker.io/bitnami/redis:7")).toBe("bitnami/redis:7");
	expect(shortImageName("ghcr.io/owner/tool:1")).toBe("ghcr.io/owner/tool:1");
	expect(shortImageName(OTHER_IMAGES_LABEL)).toBe(OTHER_IMAGES_LABEL);
});

test("list membership compares names as Docker does", () => {
	expect(listHas(["python:3.12"], "docker.io/library/python:3.12")).toBe(true);
	expect(listHas(["redis"], "docker.io/library/redis:latest")).toBe(true);
	expect(listHas(["python:3.12"], "python:3.13")).toBe(false);
});

test("the seed list uses the contract's rules and words", () => {
	expect(seedListError(["python:3.12", "node:22"], false)).toBeNull();
	expect(seedListError(["Python:3.12"], false)).toBe(
		"Must be an image name such as python:3.12 or ghcr.io/owner/name:tag.",
	);
	expect(seedListError(["quay.io/x/y:1"], false)).toBe(
		"Only Docker Hub and ghcr.io images may be seeded.",
	);
	expect(seedListError(["localhost:5000/x"], false)).not.toBeNull();
	expect(seedListError(["python:3.12", "docker.io/library/python:3.12"], false)).toBe(
		"Each image may appear once.",
	);
	// ghcr.io only while its cache is on (ruling S8).
	expect(seedListError(["ghcr.io/owner/tool:1"], false)).toBe(
		"Turn on the ghcr.io cache before seeding ghcr.io images.",
	);
	expect(seedListError(["ghcr.io/owner/tool:1"], true)).toBeNull();
	const many = Array.from({ length: 31 }, (_, i) => `image${i}:1`);
	expect(seedListError(many, false)).toBe("The seed can hold at most 30 images.");
});

test("the use report offers only images the list can take", () => {
	expect(addRefusal([], "docker.io/library/redis:7", false)).toBeNull();
	expect(addRefusal([], OTHER_IMAGES_LABEL, false)).toBe("Stands for many images.");
	expect(addRefusal([], "ghcr.io/owner/tool:1", false)).toBe(
		"Needs the ghcr.io cache on.",
	);
	expect(addRefusal([], "ghcr.io/owner/tool:1", true)).toBeNull();
});

test("cache space reads as used of total", () => {
	expect(cacheUseText(null)).toBeNull();
	expect(
		cacheUseText({
			sizeBytes: 20 * 1024 ** 3,
			usedBytes: 4.1 * 1024 ** 3,
			hubUp: true,
			ghcrEnabled: false,
			ghcrUp: false,
			hubCredentialSet: false,
			lastClearedAt: null,
			lastClearReason: null,
			updatedAt: "2026-09-30T10:00:00.000Z",
		}),
	).toBe("4.1 GB of 20.0 GB used");
});

test("the seed limit is a whole number from 1 to 64", () => {
	expect(parseSeedMaxGiB(" 8 ")).toBe(8);
	expect(parseSeedMaxGiB("64")).toBe(64);
	expect(parseSeedMaxGiB("0")).toBeNull();
	expect(parseSeedMaxGiB("65")).toBeNull();
	expect(parseSeedMaxGiB("2.5")).toBeNull();
});

test("a Docker Hub account needs a valid username and token", () => {
	expect(credentialErrors("teacher01", "fake-token-value")).toEqual({
		username: null,
		token: null,
	});
	const bad = credentialErrors("T", "short");
	expect(bad.username).toContain("4 to 30 lowercase letters");
	expect(bad.token).toContain("8 to 200 characters");
	expect(credentialErrors("teacher01", "has a space in it").token).not.toBeNull();
});
