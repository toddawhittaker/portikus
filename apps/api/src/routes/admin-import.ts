import { requireRole, requireUser } from "@portikus/auth";
import {
	type AccountImportPreview,
	AccountImportRequest,
	type AccountImportResult,
	type AccountImportResultRow,
} from "@portikus/contracts";
import { isUniqueViolation, recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
	type ClassifiedRow,
	classifyImport,
	ImportFileError,
	readImportFile,
} from "../admin/account-import.js";
import { createDexAccount, DexCallFailed } from "../admin/dex-accounts.js";
import { createInvitation } from "../admin/invitations.js";
import type { ServerDeps } from "../deps.js";
import { parseOr400, sendError } from "../http.js";
import { requestMetadata } from "../sessions/start-session.js";

/**
 * Bulk-add accounts from a CSV file (SPEC.md section 5.1, "Add user";
 * section 24.13): preview, then confirm the same text. Password rows go
 * through the Add user path, invite rows through the invitation path. The
 * one-time passwords leave the server only in the confirm response.
 */
export function registerAdminImportRoutes(
	app: FastifyInstance,
	deps: ServerDeps,
): void {
	const { db, config } = deps;
	const adminOnly = { preHandler: requireRole("administrator") };

	/** The checked rows of the uploaded text, or null after answering 400. */
	async function classify(body: unknown, reply: FastifyReply) {
		const parsed = parseOr400(
			AccountImportRequest,
			body ?? {},
			reply,
			"Send the file as text of at most 256 KB.",
		);
		if (!parsed) return null;
		try {
			const rows = readImportFile(parsed.csv);
			return await classifyImport(
				db,
				{ issuer: config.OIDC_ISSUER_URL, dexEnabled: deps.dex !== undefined },
				rows,
			);
		} catch (err) {
			if (!(err instanceof ImportFileError)) throw err;
			sendError(reply, 400, "VALIDATION_FAILED", err.message);
			return null;
		}
	}

	app.post("/admin/accounts/import/preview", adminOnly, async (request, reply) => {
		const rows = await classify(request.body, reply);
		if (!rows) return reply;
		const out: AccountImportPreview = { rows: rows.map((r) => r.preview) };
		return out;
	});

	app.post("/admin/accounts/import", adminOnly, async (request, reply) => {
		const actor = requireUser(request);
		const rows = await classify(request.body, reply);
		if (!rows) return reply;
		const metadata = requestMetadata(request);
		const results: AccountImportResultRow[] = [];
		// One at a time: each account commits alone, so one failure does not undo the rest.
		for (const row of rows)
			results.push(await apply(row, actor.id, metadata, request.log));
		const count = (outcome: AccountImportResultRow["outcome"]) =>
			results.filter((r) => r.outcome === outcome).length;
		// Counts only: never a password, name or email.
		await recordAudit(db, {
			actor: `user:${actor.id}`,
			target: "accounts",
			action: "admin.accounts_imported",
			result: "ok",
			metadata: {
				created: count("created"),
				invited: count("invited"),
				skipped: count("skipped"),
				invalid: count("invalid"),
				failed: count("failed"),
				...metadata,
			},
		});
		const out: AccountImportResult = { rows: results };
		return out;
	});

	async function apply(
		row: ClassifiedRow,
		actorId: string,
		metadata: Record<string, unknown>,
		log: FastifyInstance["log"],
	): Promise<AccountImportResultRow> {
		const { preview, valid } = row;
		const base = {
			line: preview.line,
			name: preview.name,
			email: preview.email,
			username: preview.username,
			kind: preview.kind,
		};
		if (!valid) {
			return {
				...base,
				outcome: preview.status === "duplicate" ? "skipped" : "invalid",
				reason: preview.reason,
			};
		}
		if (valid.kind === "invite") {
			try {
				await createInvitation(db, actorId, valid.body, metadata);
				return { ...base, outcome: "invited", reason: null };
			} catch (err) {
				if (!isUniqueViolation(err)) throw err;
				return {
					...base,
					outcome: "skipped",
					reason: "An invitation for this email is already waiting.",
				};
			}
		}
		const dex = deps.dex;
		if (!dex) throw new Error("a password row passed without Dex");
		try {
			const created = await createDexAccount(
				{ db, dex, issuer: config.OIDC_ISSUER_URL, log },
				{ ...valid.body, actorId, metadata },
			);
			if (created === "exists") {
				return {
					...base,
					outcome: "skipped",
					reason: "Dex already has a password for this email.",
				};
			}
			return { ...base, outcome: "created", reason: null, password: created.password };
		} catch (err) {
			if (err instanceof DexCallFailed) {
				log.error({ grpcCode: err.grpcCode }, "dex call failed");
				return { ...base, outcome: "failed", reason: "Dex could not be reached." };
			}
			if (isUniqueViolation(err)) {
				return {
					...base,
					outcome: "skipped",
					reason: "An account with this email already exists.",
				};
			}
			throw err;
		}
	}
}
