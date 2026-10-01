import {
	type EgressEntryKind,
	type EgressMode,
	EgressPresetId,
	expandEgressPolicy,
} from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import type { Kysely } from "kysely";
import { type ControllerClient, ControllerClientError } from "./controller-client.js";
import { startLoop } from "./loop.js";

/** How often the worker looks for a policy an administrator changed. */
export const EGRESS_SYNC_SECONDS = 2;

/** How long a failed apply rests before the worker tries it again. */
export const EGRESS_RETRY_SECONDS = 30;

export interface EgressSyncOptions {
	db: Kysely<Database>;
	controller: ControllerClient;
	logger: Logger;
	now?: () => Date;
}

/**
 * Build the tick that applies the egress policy (issue #284, ADR 0038).
 * The API raises `egress_version` on every write; when it is ahead of
 * `egress_applied_version`, this expands the presets, asks the controller
 * to apply, and records the outcome. A failure is recorded and audited
 * once per version, and retried after EGRESS_RETRY_SECONDS. Until an
 * administrator first writes a policy (version 0), nothing is applied and
 * the site stays in open mode.
 */
export function createEgressSync(options: EgressSyncOptions): () => Promise<void> {
	const { db, controller, logger } = options;
	const now = options.now ?? (() => new Date());
	let failed: { version: number; at: number } | null = null;
	let inFlight = false;

	return async function tick(): Promise<void> {
		if (inFlight) return;
		inFlight = true;
		try {
			const s = await db
				.selectFrom("settings")
				.select([
					"egress_mode",
					"egress_presets",
					"egress_ports",
					"egress_version",
					"egress_applied_version",
				])
				.where("id", "=", 1)
				.executeTakeFirst();
			if (!s || s.egress_version <= (s.egress_applied_version ?? 0)) return;
			const version = s.egress_version;
			if (
				failed?.version === version &&
				now().getTime() - failed.at < EGRESS_RETRY_SECONDS * 1000
			) {
				return;
			}

			const entries = await db
				.selectFrom("egress_entries")
				.select(["kind", "value", "label"])
				.execute();
			const blockedSites = await db
				.selectFrom("egress_blocked_entries")
				.select(["value", "label"])
				.execute();
			const expanded = expandEgressPolicy({
				mode: s.egress_mode as EgressMode,
				presets: s.egress_presets.filter(
					(p): p is EgressPresetId => EgressPresetId.safeParse(p).success,
				),
				ports: s.egress_ports,
				entries: entries.map((e) => ({ ...e, kind: e.kind as EgressEntryKind })),
				blockedSites,
			});
			await applyOne(version, expanded);
		} catch (e) {
			logger.warn({ error: errorMessage(e) }, "egress sync failed");
		} finally {
			inFlight = false;
		}
	};

	async function applyOne(
		version: number,
		expanded: ReturnType<typeof expandEgressPolicy>,
	): Promise<void> {
		const summary = {
			version,
			mode: expanded.mode,
			names: expanded.names.length,
			ranges: expanded.ranges.length,
			ports: expanded.ports,
			blocked: expanded.blocked.length,
		};
		try {
			await controller.applyEgressPolicy({ version, ...expanded });
		} catch (e) {
			const errorCode =
				e instanceof ControllerClientError ? e.code : "OPERATION_FAILED";
			const message = errorMessage(e);
			const firstForVersion = failed?.version !== version;
			failed = { version, at: now().getTime() };
			logger.warn({ version, errorCode }, "egress apply failed");
			await db
				.updateTable("settings")
				.set({ egress_apply_error: message.slice(0, 500) })
				.where("id", "=", 1)
				.execute();
			if (firstForVersion) {
				await recordAudit(db, {
					actor: "worker",
					target: "egress",
					action: "egress.apply_failed",
					result: "failed",
					metadata: { ...summary, errorCode },
				});
			}
			return;
		}
		failed = null;

		// Never move the applied version backwards if a newer apply raced this one.
		await db
			.updateTable("settings")
			.set({
				egress_applied_version: version,
				egress_applied_at: now().toISOString(),
				egress_apply_error: null,
			})
			.where("id", "=", 1)
			.where((eb) =>
				eb.or([
					eb("egress_applied_version", "is", null),
					eb("egress_applied_version", "<", version),
				]),
			)
			.execute();
		logger.info(summary, "egress policy applied");
		await recordAudit(db, {
			actor: "worker",
			target: "egress",
			action: "egress.applied",
			result: "ok",
			metadata: summary,
		});
	}
}

/** Run the egress sync now and then every EGRESS_SYNC_SECONDS; returns a stop function. */
export function startEgressSync(options: EgressSyncOptions): () => void {
	const tick = createEgressSync(options);
	return startLoop(tick, EGRESS_SYNC_SECONDS * 1000);
}
