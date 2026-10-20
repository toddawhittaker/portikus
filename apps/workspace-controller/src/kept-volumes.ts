// Pre-change snapshots and kept homes, and Replace home, which makes them.
import {
	KeptHomeVolumeName,
	type KeptVolumesResponse,
	PreChangeSnapshotName,
	type ReplaceHomeResponse,
	WorkspaceVolumeName,
} from "@portikus/contracts";
import { VolumeInUseError, volumeExists, volumePath } from "./host.js";
import { IncusError } from "./incus.js";
import {
	assertStopped,
	enc,
	homeDevice,
	type InstanceConfig,
	type ProviderHost,
	validateName,
	writableFields,
} from "./provider-host.js";

export async function listKeptVolumes(
	host: ProviderHost,
	signal?: AbortSignal,
): Promise<KeptVolumesResponse> {
	const volumes = (await host.client.request(
		"GET",
		`/1.0/storage-pools/${enc(host.pool)}/volumes/custom?recursion=1`,
		undefined,
		signal,
	)) as Array<{ name: string; created_at?: string }>;
	const result: KeptVolumesResponse = { snapshots: [], keptHomes: [] };
	for (const volume of volumes) {
		if (KeptHomeVolumeName.safeParse(volume.name).success) {
			result.keptHomes.push({
				volume: volume.name,
				instance: volume.name.slice(0, "ws-".length + 24),
				createdAt: volume.created_at ?? "",
			});
			continue;
		}
		if (!WorkspaceVolumeName.safeParse(volume.name).success) continue;
		const snapshots = (await host.client.request(
			"GET",
			`${volumePath(host.pool, volume.name)}/snapshots?recursion=1`,
			undefined,
			signal,
		)) as Array<{ name: string; created_at?: string }>;
		for (const snapshot of snapshots) {
			// Incus may name a snapshot `<volume>/<snapshot>`.
			const name = snapshot.name.slice(snapshot.name.lastIndexOf("/") + 1);
			if (!PreChangeSnapshotName.safeParse(name).success) continue;
			result.snapshots.push({
				volume: volume.name,
				name,
				createdAt: snapshot.created_at ?? "",
			});
		}
	}
	return result;
}

export async function deletePreChangeSnapshot(
	host: ProviderHost,
	volume: string,
	snapshot: string,
	signal?: AbortSignal,
): Promise<void> {
	// Checked again here: the backup's own snapshot must never be deleted.
	if (
		!WorkspaceVolumeName.safeParse(volume).success ||
		!PreChangeSnapshotName.safeParse(snapshot).success
	) {
		throw new IncusError("BAD_REQUEST", "only pre-change snapshots can be deleted");
	}
	await host.client.request(
		"DELETE",
		`${volumePath(host.pool, volume)}/snapshots/${enc(snapshot)}`,
		undefined,
		signal,
	);
	host.log.info({ volume, snapshot }, "snapshot deleted");
}

export async function deleteKeptHome(
	host: ProviderHost,
	volume: string,
	signal?: AbortSignal,
): Promise<void> {
	if (!KeptHomeVolumeName.safeParse(volume).success) {
		throw new IncusError("BAD_REQUEST", "only kept homes can be deleted");
	}
	const info = (await host.client.request(
		"GET",
		volumePath(host.pool, volume),
		undefined,
		signal,
	)) as {
		used_by?: string[];
	};
	if ((info.used_by ?? []).length > 0) {
		throw new VolumeInUseError(volume);
	}
	await host.client.request("DELETE", volumePath(host.pool, volume), undefined, signal);
	host.log.info({ volume }, "kept home deleted");
}

/**
 * Swap an imported home in the way Reset Docker swaps Docker's: detach
 * home, keep the old volume under a new name, rename the import, attach.
 * Each step can be repeated, so a retry finishes a half-done swap.
 */
export async function replaceHome(
	host: ProviderHost,
	name: string,
	signal?: AbortSignal,
): Promise<ReplaceHomeResponse> {
	validateName(name);
	const path = `/1.0/instances/${enc(name)}`;
	const homeVolume = `${name}-home`;
	const importVolume = `${name}-home-import`;
	const { metadata, etag } = await host.client.getWithEtag(path, signal);
	const inst = metadata as InstanceConfig;
	assertStopped(name, inst.status);

	const home = inst.devices?.home;
	if (home && (home.source !== homeVolume || home.pool !== host.pool)) {
		throw new IncusError(
			"OPERATION_FAILED",
			`instance ${name} has an unexpected home device; refusing to replace it`,
		);
	}
	const importExists = await volumeExists(host.client, host.pool, importVolume, signal);
	if (home && !importExists) {
		throw new IncusError("NOT_FOUND", `volume ${importVolume} not found`);
	}

	if (home) {
		const { home: _removed, ...devices } = inst.devices;
		await host.client.putIfMatch(
			path,
			{ ...writableFields(inst), devices },
			etag,
			signal,
		);
	}

	if (
		importExists &&
		(await volumeExists(host.client, host.pool, homeVolume, signal))
	) {
		const keptName = `${name}-home-replaced-${Math.floor(Date.now() / 1000)}`;
		await host.client.request(
			"POST",
			volumePath(host.pool, homeVolume),
			{ name: keptName },
			signal,
		);
	}
	if (importExists) {
		await host.client.request(
			"POST",
			volumePath(host.pool, importVolume),
			{ name: homeVolume },
			signal,
		);
	}

	await host.client.request(
		"PATCH",
		path,
		{ devices: { home: homeDevice(host, name) } },
		signal,
	);

	const kept = await newestKeptHome(host, name, signal);
	if (!kept) {
		throw new IncusError("OPERATION_FAILED", `no kept home for ${name}`);
	}
	host.log.info({ instance: name, kept }, "home replaced");
	return { kept };
}

async function newestKeptHome(
	host: ProviderHost,
	name: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const volumes = (await host.client.request(
		"GET",
		`/1.0/storage-pools/${enc(host.pool)}/volumes/custom?recursion=1`,
		undefined,
		signal,
	)) as Array<{ name: string }>;
	const prefix = `${name}-home-replaced-`;
	let newest: { name: string; at: number } | null = null;
	for (const { name: volume } of volumes) {
		if (!volume.startsWith(prefix)) continue;
		const at = Number(volume.slice(prefix.length));
		if (Number.isInteger(at) && (!newest || at > newest.at)) {
			newest = { name: volume, at };
		}
	}
	return newest?.name ?? null;
}
