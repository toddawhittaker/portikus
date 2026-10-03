import type {
	DockerAdminResponse,
	DockerUsageResponse,
	SeedJob,
} from "@portikus/contracts";
import { json, stubFetch } from "../../test-utils.js";

/** Fixtures and a fetch stub shared by the Docker tab's unit tests. */

const JOB_ID = "22222222-2222-4222-8222-222222222222";

export function data(over: Partial<DockerAdminResponse> = {}): DockerAdminResponse {
	return {
		cache: {
			sizeBytes: 20 * 1024 ** 3,
			usedBytes: 5 * 1024 ** 3,
			hubUp: true,
			ghcrEnabled: false,
			ghcrUp: false,
			hubCredentialSet: false,
			lastClearedAt: "2026-09-29T10:00:00.000Z",
			lastClearReason: "full",
			updatedAt: "2026-09-30T10:00:00.000Z",
		},
		ghcrEnabled: false,
		seedMaxGiB: 8,
		hubCredential: { isSet: false },
		seedImages: ["python:3.12", "node:22"],
		seed: {
			images: ["python:3.12"],
			sizeBytes: 1024 ** 3,
			imageVersion: "2026.09.9",
			builtAt: "2026-09-29T09:00:00.000Z",
		},
		imageSizes: { "docker.io/library/python:3.12": 60 * 1024 ** 2 },
		match: null,
		...over,
	};
}

export function job(over: Partial<SeedJob> = {}): SeedJob {
	return {
		id: JOB_ID,
		state: "running",
		step: "Pulling node:22 (2 of 2)",
		images: ["python:3.12", "node:22"],
		message: null,
		requestedAt: "2026-09-30T10:00:00.000Z",
		finishedAt: null,
		...over,
	};
}

export const USAGE: DockerUsageResponse = {
	windowDays: 120,
	notInSeed: [
		{
			image: "docker.io/library/redis:7",
			pulls: 5,
			workspaces: 3,
			lastSeen: "2026-09-30T08:00:00.000Z",
			downloadBytes: 40 * 1024 ** 2,
		},
		{
			image: "ghcr.io/owner/tool:1",
			pulls: 1,
			workspaces: 1,
			lastSeen: "2026-09-30T08:00:00.000Z",
			downloadBytes: null,
		},
	],
	unusedSeed: [
		{
			image: "docker.io/library/node:22",
			pulls: 0,
			workspaces: 2,
			lastSeen: "2026-09-30T07:00:00.000Z",
			downloadBytes: null,
		},
	],
	notInSeedTotal: 2,
	unusedSeedTotal: 1,
};

type Handler = (url: string, init?: RequestInit) => Response | undefined;

/** Answers the tab's reads; `writes` answers anything else first. */
export function serve(
	admin: DockerAdminResponse,
	jobs: SeedJob[] = [],
	writes?: Handler,
) {
	return stubFetch((url, init) => {
		const written = writes?.(url, init);
		if (written) return written;
		if (url === "/admin/docker") return json(200, admin);
		if (url === "/admin/docker/seed/jobs") return json(200, { jobs });
		if (url === "/admin/docker/usage") return json(200, USAGE);
		if (url === "/admin/image")
			return json(404, { code: "NOT_FOUND", message: "Not found." });
		throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
	});
}

export function bodyOf(
	fetch: ReturnType<typeof stubFetch>,
	method: string,
	url: string,
) {
	const call = fetch.mock.calls.find(
		([u, init]) => String(u) === url && init?.method === method,
	);
	return call ? JSON.parse(String(call[1]?.body ?? "null")) : undefined;
}
