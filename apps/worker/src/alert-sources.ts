import { access, statfs } from "node:fs/promises";
import { type Database, notifyAdministrators } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import type { Kysely } from "kysely";
import { startLoop } from "./loop.js";

/**
 * Conditions on the VM that need a person, raised as admin notifications
 * (STACK.md section 15), which the alert loop then pushes out. Each is raised
 * once when it starts and again only after it has cleared.
 */

const ALERT_SOURCES_SECONDS = 60;

/** Debian's flag file for an update that needs a reboot (SPEC.md section 24.4). */
const REBOOT_REQUIRED_FILE = "/run/reboot-required";

/** Failed sign-ins counted over this window... */
export const SIGNIN_WINDOW_MINUTES = 15;
/** ...raise an alert when they reach this many. */
export const SIGNIN_FAILURE_THRESHOLD = 20;

/** The root filesystem raises a danger alert at this percent used. */
export const ROOT_FS_ALERT_PERCENT = 90;

export interface AlertSourceOptions {
	db: Kysely<Database>;
	logger: Logger;
	now?: () => Date;
	rebootFile?: string;
	/** Percent of the root filesystem in use; replaceable in tests. */
	rootFsPercent?: () => Promise<number>;
}

/** Used share of `/` as `df` counts it: blocks reserved for root are not free. */
export async function rootFsUsedPercent(): Promise<number> {
	const s = await statfs("/");
	const used = s.blocks - s.bfree;
	const total = used + s.bavail;
	return total === 0 ? 0 : (used / total) * 100;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Failed password sign-ins, failed or denied logins, failed second-factor
 * codes and throttled attempts in the window (SPEC.md section 24.13).
 */
export async function countSignInFailures(
	db: Kysely<Database>,
	now: Date,
): Promise<number> {
	const since = new Date(now.getTime() - SIGNIN_WINDOW_MINUTES * 60_000);
	const row = await db
		.selectFrom("audit_events")
		.select((eb) => eb.fn.countAll<string>().as("n"))
		.where("at", ">", since)
		.where((eb) =>
			eb.or([
				eb("action", "in", [
					"auth.password_failed",
					"auth.second_factor_failed",
					"auth.throttled",
				]),
				eb.and([
					eb("action", "=", "auth.login"),
					eb("result", "in", ["failed", "denied"]),
				]),
			]),
		)
		.executeTakeFirstOrThrow();
	return Number(row.n);
}

type AlertFlag = "alert_reboot_raised" | "alert_signin_raised" | "alert_root_fs_raised";

/**
 * Build the tick. Whether each alert is raised is kept in the settings row, so
 * a worker restart does not announce a condition again; it is announced again
 * only after it has cleared (SPEC.md sections 24.4 and 24.13). The flag is
 * written after the notice, so a crash between the two repeats one alert
 * rather than losing it.
 */
export function createAlertSources(options: AlertSourceOptions): () => Promise<void> {
	const { db, logger } = options;
	const now = options.now ?? (() => new Date());
	const rebootFile = options.rebootFile ?? REBOOT_REQUIRED_FILE;
	const rootFsPercent = options.rootFsPercent ?? rootFsUsedPercent;

	async function raisedFlags(): Promise<Record<AlertFlag, boolean>> {
		const row = await db
			.selectFrom("settings")
			.select(["alert_reboot_raised", "alert_signin_raised", "alert_root_fs_raised"])
			.where("id", "=", 1)
			.executeTakeFirst();
		return (
			row ?? {
				alert_reboot_raised: false,
				alert_signin_raised: false,
				alert_root_fs_raised: false,
			}
		);
	}

	async function saveFlag(flag: AlertFlag, value: boolean): Promise<void> {
		await db
			.updateTable("settings")
			.set({ [flag]: value })
			.where("id", "=", 1)
			.execute();
	}

	return async function tick(): Promise<void> {
		try {
			const raised = await raisedFlags();

			const reboot = await fileExists(rebootFile);
			if (reboot && !raised.alert_reboot_raised) {
				await notifyAdministrators(db, {
					tone: "warning",
					title: "The server needs a reboot to finish a security update",
					body: "Reboot the VM at a quiet time; running workspaces stop while it restarts.",
				});
				logger.info("reboot-required alert raised");
			}
			if (reboot !== raised.alert_reboot_raised) {
				await saveFlag("alert_reboot_raised", reboot);
			}

			const failures = await countSignInFailures(db, now());
			const spike = failures >= SIGNIN_FAILURE_THRESHOLD;
			if (spike && !raised.alert_signin_raised) {
				await notifyAdministrators(db, {
					tone: "warning",
					title: `${failures} failed sign-ins in the last ${SIGNIN_WINDOW_MINUTES} minutes`,
					body: "The Audit tab on the admin page lists them.",
				});
				logger.info({ failures }, "sign-in failure alert raised");
			}
			if (spike !== raised.alert_signin_raised) {
				await saveFlag("alert_signin_raised", spike);
			}

			const rootFill = await rootFsPercent();
			const rootFull = rootFill >= ROOT_FS_ALERT_PERCENT;
			if (rootFull && !raised.alert_root_fs_raised) {
				await notifyAdministrators(db, {
					tone: "danger",
					title: `The server's system disk is ${Math.floor(rootFill)}% full`,
					body: "Free space on the VM's root filesystem before the database or logs stop writing.",
				});
				logger.info(
					{ fillPercent: Math.floor(rootFill) },
					"root filesystem alert raised",
				);
			}
			if (rootFull !== raised.alert_root_fs_raised) {
				await saveFlag("alert_root_fs_raised", rootFull);
			}
		} catch (e) {
			logger.warn({ error: errorMessage(e) }, "alert source check failed");
		}
	};
}

export function startAlertSources(options: AlertSourceOptions): () => void {
	return startLoop(
		"alert sources",
		options.logger,
		createAlertSources(options),
		ALERT_SOURCES_SECONDS * 1000,
	);
}
