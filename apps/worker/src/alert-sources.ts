import { access } from "node:fs/promises";
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

export interface AlertSourceOptions {
	db: Kysely<Database>;
	logger: Logger;
	now?: () => Date;
	rebootFile?: string;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** Failed password sign-ins plus failed or denied logins in the window. */
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
				eb("action", "=", "auth.password_failed"),
				eb.and([
					eb("action", "=", "auth.login"),
					eb("result", "in", ["failed", "denied"]),
				]),
			]),
		)
		.executeTakeFirstOrThrow();
	return Number(row.n);
}

/** Build the tick; the raised state is in memory, so a restart may repeat one alert. */
export function createAlertSources(options: AlertSourceOptions): () => Promise<void> {
	const { db, logger } = options;
	const now = options.now ?? (() => new Date());
	const rebootFile = options.rebootFile ?? REBOOT_REQUIRED_FILE;
	let rebootRaised = false;
	let signInRaised = false;

	return async function tick(): Promise<void> {
		try {
			const reboot = await fileExists(rebootFile);
			if (reboot && !rebootRaised) {
				await notifyAdministrators(db, {
					tone: "warning",
					title: "The server needs a reboot to finish a security update",
					body: "Reboot the VM at a quiet time; running workspaces stop while it restarts.",
				});
				logger.info("reboot-required alert raised");
			}
			rebootRaised = reboot;

			const failures = await countSignInFailures(db, now());
			const spike = failures >= SIGNIN_FAILURE_THRESHOLD;
			if (spike && !signInRaised) {
				await notifyAdministrators(db, {
					tone: "warning",
					title: `${failures} failed sign-ins in the last ${SIGNIN_WINDOW_MINUTES} minutes`,
					body: "The Audit tab on the admin page lists them.",
				});
				logger.info({ failures }, "sign-in failure alert raised");
			}
			signInRaised = spike;
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
