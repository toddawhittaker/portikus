import type { Database } from "@portikus/db";
import {
	captureMail,
	type MailTransportFactory,
	readNotifyFile,
	sendMail,
} from "@portikus/observability";
import type { Kysely } from "kysely";
import type { AccountMessage } from "./messages.js";

/**
 * Send one account email (SPEC.md section 5.3) through the SMTP server in
 * the notification settings (ADR 0052). It sends only when the site switch
 * is on, so SMTP set for alerts alone never emails students. Nothing here
 * logs: the caller decides what to record, and never the address or a link.
 */

export type AccountEmailResult =
	| { ok: true }
	/** `disabled`: the switch is off. `no-smtp`: no server is set. `failed`: the server did not take it. */
	| { ok: false; reason: "disabled" | "no-smtp" | "failed" };

export interface AccountEmailDeps {
	db: Kysely<Database>;
	notifyFile: string;
	proxyUrl?: string;
	/** Development only (MAIL_CAPTURE_FILE): append here instead of sending; SMTP is then not needed. */
	captureFile?: string;
	transportFactory?: MailTransportFactory;
}

/** Whether the administrator turned account email on; a site with no settings row has it off. */
export async function accountEmailEnabled(db: Kysely<Database>): Promise<boolean> {
	const row = await db
		.selectFrom("settings")
		.select("account_email_enabled")
		.where("id", "=", 1)
		.executeTakeFirst();
	return row?.account_email_enabled ?? false;
}

export async function sendAccountEmail(
	deps: AccountEmailDeps,
	to: string,
	message: AccountMessage,
): Promise<AccountEmailResult> {
	if (!(await accountEmailEnabled(deps.db))) return { ok: false, reason: "disabled" };
	if (deps.captureFile) {
		await captureMail(deps.captureFile, { to, ...message });
		return { ok: true };
	}
	// Read now, so a change to the settings needs no restart (ADR 0052).
	const { smtp } = await readNotifyFile(deps.notifyFile);
	if (!smtp) return { ok: false, reason: "no-smtp" };
	const error = await sendMail(
		smtp,
		deps.proxyUrl,
		{ to, ...message },
		deps.transportFactory,
	);
	return error ? { ok: false, reason: "failed" } : { ok: true };
}
