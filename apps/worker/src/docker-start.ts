import {
	type EgressEntryKind,
	type EgressMode,
	type EgressPolicy,
	EgressPresetId,
	explainHost,
	GHCR_UPSTREAM_NAMES,
	HUB_UPSTREAM_NAMES,
	type WorkspaceDockerConfig,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";

/**
 * The Docker config for one start: the Hub mirror only when the
 * policy lets every Hub name through, and ghcr.io only when its switch is
 * on and the policy lets its names through. Otherwise dockerd would try a
 * cache the egress gate drops.
 */
export function dockerConfigFor(
	policy: EgressPolicy,
	ghcrEnabled: boolean,
): WorkspaceDockerConfig {
	const allows = (names: readonly string[]): boolean =>
		names.every((name) => explainHost(policy, name).allowed);
	return {
		hubMirror: allows(HUB_UPSTREAM_NAMES),
		ghcr: ghcrEnabled && allows(GHCR_UPSTREAM_NAMES),
	};
}

/** Read the saved egress policy and ghcr switch, and decide the start's Docker config. */
export async function dockerStartConfig(
	db: Kysely<Database>,
): Promise<WorkspaceDockerConfig> {
	const s = await db
		.selectFrom("settings")
		.select(["egress_mode", "egress_presets", "docker_ghcr_enabled"])
		.where("id", "=", 1)
		.executeTakeFirst();
	const entries = await db
		.selectFrom("egress_entries")
		.select(["kind", "value", "label"])
		.execute();
	const blockedSites = await db
		.selectFrom("egress_blocked_entries")
		.select(["value", "label"])
		.execute();
	const policy: EgressPolicy = {
		mode: (s?.egress_mode ?? "open") as EgressMode,
		presets: (s?.egress_presets ?? []).filter(
			(p): p is EgressPresetId => EgressPresetId.safeParse(p).success,
		),
		ports: [],
		entries: entries.map((e) => ({ ...e, kind: e.kind as EgressEntryKind })),
		blockedSites,
	};
	return dockerConfigFor(policy, s?.docker_ghcr_enabled ?? true);
}
