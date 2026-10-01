/**
 * The inner Docker containers that publish ports, and stopping one
 * (SPEC.md §18.2). Docker runs by absolute path through runDocker.
 */
import { runDocker } from "./docker-inventory.js";

/** How long `docker ps` may take before we give up on it for this scan. */
export const DOCKER_TIMEOUT_MS = 500;

/** How long `docker stop` may take. */
export const DOCKER_STOP_TIMEOUT_MS = 15_000;

/** A running inner Docker container and the host ports it publishes. */
export interface DockerContainer {
	id: string;
	name: string;
	ports: number[];
}

export type DockerLookup = () => Promise<DockerContainer[]>;

/** Stop an inner Docker container by id or name. */
export async function dockerStopContainer(container: string): Promise<void> {
	await runDocker(["stop", container], DOCKER_STOP_TIMEOUT_MS);
}

/** Ask Docker which containers are running and what ports they publish. */
export async function dockerPs(): Promise<DockerContainer[]> {
	const stdout = await runDocker(
		["ps", "--format", "{{.ID}}\t{{.Names}}\t{{.Ports}}"],
		DOCKER_TIMEOUT_MS,
	);
	return parseDockerPs(stdout);
}

/** Parse `docker ps` rows into containers and the host ports they publish. */
export function parseDockerPs(stdout: string): DockerContainer[] {
	const containers: DockerContainer[] = [];
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") continue;
		const [id, name, ports] = line.split("\t");
		if (!id || !name) continue;
		const published = new Set<number>();
		// Rows look like "0.0.0.0:5432->5432/tcp, :::5432->5432/tcp".
		for (const match of (ports ?? "").matchAll(/:(\d+)->/g)) {
			published.add(Number.parseInt(match[1] ?? "0", 10));
		}
		containers.push({ id, name, ports: [...published] });
	}
	return containers;
}
