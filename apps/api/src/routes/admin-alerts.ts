import { randomUUID } from "node:crypto";
import { requireRole, requireUser } from "@portikus/auth";
import {
	type AdminNotifications,
	type AlertChannelKind,
	isJobActive,
	NOTIFY_FILE_OFF,
	NOTIFY_JOB_STALE_MS,
	NotificationSettingsUpdate,
	type NotifyJobRequestFile,
	notificationSettingsView,
	TestAlertRequest,
	type TestAlertResponse,
} from "@portikus/contracts";
import { notifyAdministrators, recordAudit } from "@portikus/db";
import {
	type AlertChannels,
	alertChannelsFromNotifyFile,
	errorMessage,
	readNotifyFile,
	sendAlert,
} from "@portikus/observability";
import type { FastifyInstance, FastifyReply } from "fastify";
import { allJobs, changeSummary, channelsLeaving, queuedView } from "../alerts/jobs.js";
import type { ServerDeps } from "../deps.js";
import { sendError, sendNoStoreError } from "../http.js";
import {
	currentJob,
	removeStaleRequests,
	sweepTempRequests,
	writeRequestFile,
} from "../job-files.js";
import { testAlertLimit } from "../rate-limit.js";

const adminOnly = { preHandler: requireRole("administrator") };
const BUSY_MESSAGE = "A notification settings change is already waiting or running.";
const UNREADABLE_MESSAGE = "The notification settings file cannot be read.";

/** Only the named kinds of `channels`. */
function onlyChannels(
	channels: AlertChannels,
	kinds: AlertChannelKind[],
): AlertChannels {
	return {
		pushoverUserKey: kinds.includes("pushover") ? channels.pushoverUserKey : "",
		pushoverAppToken: kinds.includes("pushover") ? channels.pushoverAppToken : "",
		webhookUrl: kinds.includes("webhook") ? channels.webhookUrl : "",
		email: kinds.includes("email") ? channels.email : null,
		ntfy: kinds.includes("ntfy") ? channels.ntfy : null,
		teamsUrl: kinds.includes("teams") ? channels.teamsUrl : "",
		proxyUrl: channels.proxyUrl,
	};
}

/**
 * The Notifications section of the Settings tab (ADR 0052, STACK.md section
 * 15). Settings live in NOTIFY_FILE, owned by root; the API reads it and
 * writes nothing but a request file into ALERTS_JOBS_DIR for the root
 * alerts job. Secrets travel only in that file and never come back out.
 * With ALERTS_JOBS_DIR unset the settings routes are 404.
 */
export function registerAdminAlertRoutes(
	app: FastifyInstance,
	{ db, config, logger }: ServerDeps,
): void {
	const jobsDir = config.ALERTS_JOBS_DIR;
	const testLimit = testAlertLimit();
	// One API process: this closes the gap between checking and writing.
	let writing = false;

	/** The file now, or null after answering 500; the error names only the path. */
	async function readSettings(reply: FastifyReply) {
		try {
			return await readNotifyFile(config.NOTIFY_FILE);
		} catch (e) {
			logger.error({ error: errorMessage(e) }, "notification settings unreadable");
			sendNoStoreError(reply, 500, "INTERNAL", UNREADABLE_MESSAGE);
			return null;
		}
	}

	app.get("/admin/notifications", adminOnly, async (_request, reply) => {
		if (!jobsDir) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		// A broken file must not hide the form whose save repairs it.
		let file = NOTIFY_FILE_OFF;
		let storedFileUnreadable = false;
		try {
			file = await readNotifyFile(config.NOTIFY_FILE);
		} catch {
			// A parse error can quote the file, so only its path is logged.
			logger.error({ path: config.NOTIFY_FILE }, "notification settings unreadable");
			storedFileUnreadable = true;
		}
		const out: AdminNotifications = {
			settings: notificationSettingsView(file),
			job: currentJob(await allJobs(jobsDir), NOTIFY_JOB_STALE_MS),
			storedFileUnreadable,
		};
		return reply.header("cache-control", "no-store").send(out);
	});

	app.put("/admin/notifications", adminOnly, async (request, reply) => {
		if (!jobsDir) return sendError(reply, 404, "NOT_FOUND", "Not found.");
		const admin = requireUser(request);
		const body = NotificationSettingsUpdate.safeParse(request.body ?? {});
		if (!body.success) {
			// Zod's issues can quote the input; only the field paths are named.
			const fields = [...new Set(body.error.issues.map((i) => i.path.join(".")))];
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				`Check these fields: ${fields.join(", ") || "settings"}.`,
			);
		}
		if (writing) return sendError(reply, 409, "NOTIFY_JOB_BUSY", BUSY_MESSAGE);
		writing = true;
		try {
			const jobs = await allJobs(jobsDir);
			if (jobs.some((j) => isJobActive(j, NOTIFY_JOB_STALE_MS))) {
				return sendError(reply, 409, "NOTIFY_JOB_BUSY", BUSY_MESSAGE);
			}
			await removeStaleRequests(jobsDir, jobs, NOTIFY_JOB_STALE_MS);
			// A broken file must not block the save that repairs it.
			const current = await readNotifyFile(config.NOTIFY_FILE).catch((e) => {
				logger.error(
					{ error: errorMessage(e) },
					"notification settings unreadable; saving over them",
				);
				return NOTIFY_FILE_OFF;
			});
			const id = randomUUID();
			const requestedAt = new Date().toISOString();
			const summary = changeSummary(notificationSettingsView(current), body.data);
			const audit = {
				actor: `user:${admin.id}`,
				target: id,
				action: "settings.notifications_updated",
				metadata: { job: id, ...summary },
			};
			// The row comes first: no change is ever applied without one. The job's status says how it ended.
			await recordAudit(db, { ...audit, result: "requested" });
			const notice = {
				title: `Notification settings change requested by ${admin.displayName} (job ${id.slice(0, 8)})`,
				text: `Changed: ${summary.changed.join(", ") || "nothing"}. Alert hosts: ${summary.hosts.join(", ") || "none"}. Root-shell alert: ${summary.rootShellOpenedAlert ? "on" : "off"}.`,
			};
			// Straight to the old target of each channel this change turns off or
			// re-targets, so it still hears of the change; the worker reaches every
			// channel on afterwards (ADR 0052). Best effort: it never holds up the save.
			const leaving = channelsLeaving(summary);
			if (leaving.length > 0) {
				void sendAlert(
					onlyChannels(
						alertChannelsFromNotifyFile(current, config.OUTBOUND_PROXY_URL),
						leaving,
					),
					{ ...notice, tone: "warning", at: new Date() },
				)
					.then((results) => {
						for (const r of results)
							if (!r.ok)
								logger.warn(
									{ channel: r.channel, error: r.error },
									"change alert could not be sent",
								);
					})
					.catch((e) =>
						logger.warn({ error: errorMessage(e) }, "change alert could not be sent"),
					);
			}
			const file: NotifyJobRequestFile = {
				id,
				requestedAt,
				requestedBy: admin.id,
				settings: body.data,
			};
			try {
				await sweepTempRequests(jobsDir);
				// Owner-only, because it may hold secrets.
				await writeRequestFile(jobsDir, file, 0o600);
			} catch (e) {
				await recordAudit(db, { ...audit, result: "failed" });
				throw e;
			}
			// The job id in the title keeps the worker's flood control from hiding a second change.
			await notifyAdministrators(db, {
				tone: "warning",
				title: notice.title,
				body: notice.text,
			});
			return reply.status(202).send(queuedView(id, requestedAt));
		} finally {
			writing = false;
		}
	});

	/**
	 * Send one alert straight to one configured channel, or to all of them,
	 * so an administrator can check delivery. It writes no notification, so
	 * the worker's forwarder never repeats it.
	 */
	app.post(
		"/admin/alerts/test",
		{ preHandler: [requireRole("administrator"), testLimit] },
		async (request, reply) => {
			const admin = requireUser(request);
			const body = TestAlertRequest.safeParse(request.body ?? {});
			if (!body.success) {
				return sendError(reply, 400, "VALIDATION_FAILED", "Unknown alert channel.");
			}
			const file = await readSettings(reply);
			if (!file) return;
			const all = alertChannelsFromNotifyFile(file, config.OUTBOUND_PROXY_URL);
			const channels = body.data.channel ? onlyChannels(all, [body.data.channel]) : all;
			const results = await sendAlert(channels, {
				title: "Test alert from Portikus",
				text: "An administrator sent this from the admin page to check alert delivery.",
				tone: "warning",
				at: new Date(),
			});
			for (const r of results)
				logger.info(
					{ channel: r.channel, ok: r.ok, error: r.error },
					"test alert sent",
				);
			await recordAudit(db, {
				actor: `user:${admin.id}`,
				target: body.data.channel ?? "all",
				action: "settings.alert_tested",
				result: results.every((r) => r.ok) ? "ok" : "failed",
				metadata: { results: results.map((r) => ({ channel: r.channel, ok: r.ok })) },
			});
			const out: TestAlertResponse = { results };
			return reply.header("cache-control", "no-store").send(out);
		},
	);
}
