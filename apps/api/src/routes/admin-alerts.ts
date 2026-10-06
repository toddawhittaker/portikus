import { randomUUID } from "node:crypto";
import { requireRole, requireUser } from "@portikus/auth";
import {
	type AdminNotifications,
	type AlertChannelKind,
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
	readNotifyFile,
	sendAlert,
} from "@portikus/observability";
import type { FastifyInstance, FastifyReply } from "fastify";
import { allJobs, changeSummary, queuedView } from "../alerts/jobs.js";
import type { ServerDeps } from "../deps.js";
import { sendError, sendNoStoreError } from "../http.js";
import { currentJob, sweepTempRequests, writeRequestFile } from "../job-files.js";

const adminOnly = { preHandler: requireRole("administrator") };
const BUSY_MESSAGE = "A notification settings change is already waiting or running.";
const UNREADABLE_MESSAGE = "The notification settings file cannot be read.";

/** Only `kind` of `channels`, or all of them when no kind is named. */
function onlyChannel(channels: AlertChannels, kind?: AlertChannelKind): AlertChannels {
	if (!kind) return channels;
	return {
		pushoverUserKey: kind === "pushover" ? channels.pushoverUserKey : "",
		pushoverAppToken: kind === "pushover" ? channels.pushoverAppToken : "",
		webhookUrl: kind === "webhook" ? channels.webhookUrl : "",
		email: kind === "email" ? channels.email : null,
		ntfy: kind === "ntfy" ? channels.ntfy : null,
		teamsUrl: kind === "teams" ? channels.teamsUrl : "",
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
	// One API process: this closes the gap between checking and writing.
	let writing = false;

	function off(reply: FastifyReply): boolean {
		if (jobsDir) return false;
		sendError(reply, 404, "NOT_FOUND", "Not found.");
		return true;
	}

	/** The file now, or null after answering 500; the error names only the path. */
	async function readSettings(reply: FastifyReply) {
		try {
			return await readNotifyFile(config.NOTIFY_FILE);
		} catch (e) {
			logger.error({ error: (e as Error).message }, "notification settings unreadable");
			sendNoStoreError(reply, 500, "INTERNAL", UNREADABLE_MESSAGE);
			return null;
		}
	}

	app.get("/admin/notifications", adminOnly, async (_request, reply) => {
		if (off(reply) || !jobsDir) return;
		const file = await readSettings(reply);
		if (!file) return;
		const out: AdminNotifications = {
			settings: notificationSettingsView(file),
			job: currentJob(await allJobs(jobsDir)),
		};
		return reply.header("cache-control", "no-store").send(out);
	});

	app.put("/admin/notifications", adminOnly, async (request, reply) => {
		if (off(reply) || !jobsDir) return;
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
			if (jobs.some((j) => j.state === "queued" || j.state === "running")) {
				return sendError(reply, 409, "NOTIFY_JOB_BUSY", BUSY_MESSAGE);
			}
			const current = await readSettings(reply);
			if (!current) return;
			const id = randomUUID();
			const requestedAt = new Date().toISOString();
			const file: NotifyJobRequestFile = {
				id,
				requestedAt,
				requestedBy: admin.id,
				settings: body.data,
			};
			await sweepTempRequests(jobsDir);
			// Owner-only, because it may hold secrets.
			await writeRequestFile(jobsDir, file, 0o600);
			const summary = changeSummary(notificationSettingsView(current), body.data);
			await recordAudit(db, {
				actor: `user:${admin.id}`,
				target: id,
				action: "settings.notifications_updated",
				result: "ok",
				metadata: { job: id, ...summary },
			});
			// Any change may send alerts to a new host, so every administrator hears of it (ADR 0052).
			await notifyAdministrators(db, {
				tone: "warning",
				title: `Notification settings changed by ${admin.displayName}`,
				body: `Changed: ${summary.changed.join(", ") || "nothing"}. Alert hosts: ${summary.hosts.join(", ") || "none"}.`,
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
	app.post("/admin/alerts/test", adminOnly, async (request, reply) => {
		const body = TestAlertRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", "Unknown alert channel.");
		}
		const file = await readSettings(reply);
		if (!file) return;
		const channels = onlyChannel(
			alertChannelsFromNotifyFile(file, config.OUTBOUND_PROXY_URL),
			body.data.channel,
		);
		const results = await sendAlert(channels, {
			title: "Test alert from Portikus",
			text: "An administrator sent this from the admin page to check alert delivery.",
			tone: "warning",
			at: new Date(),
		});
		for (const r of results)
			logger.info({ channel: r.channel, ok: r.ok, error: r.error }, "test alert sent");
		const out: TestAlertResponse = { results };
		return reply.header("cache-control", "no-store").send(out);
	});
}
