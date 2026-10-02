import {
	type AdminImageVersion,
	type AdminWorkspaceSummary,
	type CpuThrottle,
	countIncusCpus,
	HealthSample,
	type MemoryFlag,
	type QuotaConfig,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import { fromJson, type WorkspaceRow } from "../workspaces/workspace-view.js";

/** What the newest health sample says about images, or null without one. */
export interface ImageFacts {
	currentFingerprint: string | null;
	instances: Map<string, { fingerprint: string | null; serial: string | null }>;
}

/** The host part of the newest health sample the worker wrote, or null. */
async function loadNewestHost(
	db: Kysely<Database>,
): Promise<NonNullable<HealthSample["host"]> | null> {
	const row = await db
		.selectFrom("health_samples")
		.select("sample")
		.orderBy("observed_at", "desc")
		.orderBy("id", "desc")
		.limit(1)
		.executeTakeFirst();
	if (!row) return null;
	const parsed = HealthSample.safeParse(row.sample);
	return parsed.success ? parsed.data.host : null;
}

/** Read the image facts from the newest health sample the worker wrote. */
export async function loadImageFacts(db: Kysely<Database>): Promise<ImageFacts | null> {
	const host = await loadNewestHost(db);
	if (!host) return null;
	return {
		currentFingerprint: host.image.fingerprint,
		instances: new Map(
			host.instances.map((one) => [
				one.name,
				{ fingerprint: one.imageFingerprint, serial: one.imageSerial },
			]),
		),
	};
}

/**
 * The readable image of one instance: its `image.serial`, else the first 12
 * characters of its fingerprint, compared with the current image.
 */
export function toImageVersion(
	instanceName: string | null,
	storedFingerprint: string | null,
	facts: ImageFacts | null,
): AdminImageVersion {
	const seen = instanceName === null ? undefined : facts?.instances.get(instanceName);
	const fingerprint = seen?.fingerprint ?? storedFingerprint;
	const label = seen?.serial ?? (fingerprint ? fingerprint.slice(0, 12) : null);
	const current =
		facts?.currentFingerprint && fingerprint
			? fingerprint === facts.currentFingerprint
			: null;
	return { label, fingerprint, current };
}

/**
 * The host's CPU count and the profile's CPU count, from the newest health
 * sample. Like the guard, a profile without a readable `limits.cpu` counts as
 * the whole host.
 */
export async function loadHostCpu(
	db: Kysely<Database>,
): Promise<{ cpuCount: number; profileCpu: number } | null> {
	const host = await loadNewestHost(db);
	if (!host) return null;
	const { cpuCount, profileLimits } = host;
	return { cpuCount, profileCpu: countIncusCpus(profileLimits.cpu) ?? cpuCount };
}

export function iso(value: Date | null): string | null {
	return value ? value.toISOString() : null;
}

/** One workspace as a row of the admin list shows it. */
export function toWorkspaceSummary(
	row: WorkspaceRow,
	activeConnections: number,
	facts: ImageFacts | null,
	defaults: QuotaConfig,
): AdminWorkspaceSummary {
	return {
		id: row.id,
		label: row.label,
		state: row.state,
		desiredState: row.desired_state,
		activeConnections,
		lastActiveConnectionAt: iso(row.last_active_connection_at),
		quotaConfig: fromJson<QuotaConfig>(row.quota_config) ?? defaults,
		quotaApplied: fromJson<QuotaConfig>(row.quota_applied),
		image: toImageVersion(row.incus_instance_name, row.image_version, facts),
		archivedAt: iso(row.archived_at),
		pendingOperation: row.pending_operation,
		cpuThrottle: fromJson<CpuThrottle>(row.cpu_throttle),
		memoryFlag: fromJson<MemoryFlag>(row.memory_flag),
	};
}
