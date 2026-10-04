import { dexLocalSubject, LOCAL_ADMIN_USER_ID } from "@portikus/auth";
import { type Database, recordAudit } from "@portikus/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { sendError } from "../http.js";
import { requestMetadata } from "../sessions/start-session.js";

export const INSTALL_ADMIN_REFUSAL =
	"Only the install administrator can change the install administrator account. Recover it on the host with portikus reset-admin.";

/** Whether `userId` is the install administrator (SPEC.md section 5.1). */
async function isInstallAdmin(
	db: Kysely<Database>,
	issuer: string,
	userId: string,
): Promise<boolean> {
	const row = await db
		.selectFrom("users")
		.select("id")
		.where("id", "=", userId)
		.where("oidc_issuer", "=", issuer)
		.where("oidc_subject", "=", dexLocalSubject(LOCAL_ADMIN_USER_ID))
		.executeTakeFirst();
	return row !== undefined;
}

/**
 * Refuse and audit another administrator's change to the install
 * administrator (SPEC.md section 24.13). Returns true when it answered.
 */
export async function refuseInstallAdminChange(
	db: Kysely<Database>,
	issuer: string,
	input: {
		request: FastifyRequest;
		reply: FastifyReply;
		actorId: string;
		targetId: string;
		action: string;
	},
): Promise<boolean> {
	const { request, reply, actorId, targetId, action } = input;
	if (actorId === targetId) return false;
	if (!(await isInstallAdmin(db, issuer, targetId))) return false;
	await recordAudit(db, {
		actor: `user:${actorId}`,
		target: targetId,
		action,
		result: "denied",
		metadata: { reason: "install_administrator", ...requestMetadata(request) },
	});
	sendError(reply, 403, "FORBIDDEN", INSTALL_ADMIN_REFUSAL);
	return true;
}
