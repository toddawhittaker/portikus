import { OTHER_IMAGES_LABEL } from "@portikus/contracts";
import { expect, test } from "vitest";
import {
	addRefusal,
	autoClearBytes,
	cacheUseText,
	clearErrorText,
	credentialErrors,
	downloadSize,
	listHas,
	listSizeText,
	parseSeedMaxGiB,
	seedListError,
	seedUseText,
	shortImageName,
	shownText,
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

test("a saved ghcr.io name with the cache off is blamed on the list, not the row", () => {
	expect(addRefusal(["ghcr.io/owner/tool:1"], "docker.io/library/redis:7", false)).toBe(
		"The seed list has ghcr.io images; turn on the ghcr.io cache or remove them first.",
	);
	expect(
		addRefusal(["ghcr.io/owner/tool:1"], "docker.io/library/redis:7", true),
	).toBeNull();
});

test("capped usage tables say how many rows they show", () => {
	expect(shownText(200, 200)).toBeNull();
	expect(shownText(3, 3)).toBeNull();
	expect(shownText(200, 340)).toBe("Showing 200 of 340.");
});

test("a failed clear is shown, and a stopped Hub cache waits for a clear that works", () => {
	const cache = {
		sizeBytes: 1,
		usedBytes: 0,
		hubUp: true,
		ghcrEnabled: false,
		ghcrUp: false,
		hubCredentialSet: true,
		lastClearedAt: null,
		lastClearReason: null,
		updatedAt: "2026-09-30T10:00:00.000Z",
	};
	expect(clearErrorText(cache)).toBeNull();
	expect(clearErrorText({ ...cache, lastClearError: null })).toBeNull();
	expect(clearErrorText({ ...cache, lastClearError: "disk busy" })).toBe(
		"The last clear failed: disk busy",
	);
	expect(clearErrorText({ ...cache, hubUp: false, lastClearError: "disk busy" })).toBe(
		"The last clear failed: disk busy The Docker Hub cache stays stopped until Clear cache succeeds.",
	);
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

const MB = 1024 ** 2;
const SIZES = {
	"docker.io/library/python:3.12": 60 * MB,
	"docker.io/library/redis:latest": 40 * MB,
	"ghcr.io/owner/tool:1": 5 * MB,
};

test("a download size is found by any name Docker reads the same, or is null", () => {
	expect(downloadSize(SIZES, "python:3.12")).toBe(60 * MB);
	expect(downloadSize(SIZES, "docker.io/library/python:3.12")).toBe(60 * MB);
	expect(downloadSize(SIZES, "redis")).toBe(40 * MB);
	expect(downloadSize(SIZES, "ghcr.io/owner/tool:1")).toBe(5 * MB);
	expect(downloadSize(SIZES, "node:22")).toBeNull();
});

test("the list's size sentence totals what is known and says what is not", () => {
	const limit =
		"The limit of 8.0 GB counts the unpacked images, which take more space than their download.";
	expect(listSizeText(["python:3.12", "redis"], SIZES, 8)).toBe(
		`These images download as 100 MB. ${limit}`,
	);
	expect(listSizeText(["python:3.12", "node:22"], SIZES, 8)).toBe(
		`These images download as 60.0 MB, not counting 1 image the pull cache has not held. ${limit}`,
	);
	expect(listSizeText(["python:3.12", "node:22", "go:1"], SIZES, 8)).toContain(
		"not counting 2 images the pull cache has not held",
	);
	expect(listSizeText(["node:22"], SIZES, 8)).toBe(
		`Download sizes are not known yet; the pull cache has not held these images. ${limit}`,
	);
});

test("the meters' figures: the seed against its limit, the cache's auto-clear tick", () => {
	expect(seedUseText(2 * 1024 ** 3, 8)).toBe("2.0 GB of the 8.0 GB limit");
	const cache = {
		sizeBytes: 20 * 1024 ** 3,
		usedBytes: 0,
		hubUp: true,
		ghcrEnabled: false,
		ghcrUp: false,
		hubCredentialSet: false,
		lastClearedAt: null,
		lastClearReason: null,
		updatedAt: "2026-09-30T10:00:00.000Z",
	};
	expect(autoClearBytes(cache)).toBe(18 * 1024 ** 3);
});
