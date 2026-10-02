import { connect } from "node:net";
import { requireRole, requireUser } from "@portikus/auth";
import {
	BACKUP_KEY_FILE_NAME,
	type BackupKeyStatus,
	BackupKeyUpload,
	type BackupKeyUploadResult,
	BackupRecipient,
} from "@portikus/contracts";
import { recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { sendError } from "../http.js";
import type { ServerDeps } from "../server.js";

const adminOnly = { preHandler: requireRole("administrator") };
const HELPER_TIMEOUT_MS = 10_000;
/** A key answer is under 300 bytes; anything this long is not the helper. */
const HELPER_MAX_BYTES = 16 * 1024;
const IDENTITY = /^AGE-SECRET-KEY-1[0-9A-Z]{58}$/m;

/** What the helper's `status` prints on its second line. */
const HelperStatus = z
	.object({
		installed: z.boolean(),
		recipient: BackupRecipient.nullable(),
		handedOutRecipient: BackupRecipient.nullable(),
		handedOutAt: z.number().int().nonnegative().nullable(),
	})
	.strict();

class KeyHelperError extends Error {}

/**
 * One request to the root backup key helper (portikus-backup-key.socket,
 * ADR 0044): a verb line and an optional body, then its whole answer. An
 * error never carries the answer, which may hold the key.
 */
export function askKeyHelper(
	socketPath: string,
	verb: "status" | "export" | "import" | "import-replace" | `mark-downloaded ${string}`,
	body = "",
): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let failed: Error | null = null;
		const socket = connect(socketPath);
		const fail = (error: Error) => {
			failed ??= error;
			socket.destroy();
		};
		const timer = setTimeout(
			() => fail(new KeyHelperError("the backup key helper did not answer in time")),
			HELPER_TIMEOUT_MS,
		);
		socket.on("connect", () => {
			socket.end(`${verb}\n${body}`);
		});
		socket.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > HELPER_MAX_BYTES) {
				fail(new KeyHelperError("the backup key helper answered too much"));
				return;
			}
			chunks.push(chunk);
		});
		socket.on("error", (error: NodeJS.ErrnoException) => {
			fail(
				new KeyHelperError(
					`the backup key helper is unreachable (${error.code ?? "error"})`,
				),
			);
		});
		socket.on("close", () => {
			clearTimeout(timer);
			if (failed) reject(failed);
			else resolve(Buffer.concat(chunks).toString("utf8"));
		});
	});
}

/** The answer's first line split into words, and everything after it. */
function splitAnswer(answer: string): { words: string[]; rest: string } {
	const newline = answer.indexOf("\n");
	const first = newline === -1 ? answer : answer.slice(0, newline);
	return {
		words: first.split(" "),
		rest: newline === -1 ? "" : answer.slice(newline + 1),
	};
}

function toStatus(helper: z.infer<typeof HelperStatus>): BackupKeyStatus {
	const downloaded =
		helper.installed &&
		helper.recipient !== null &&
		helper.handedOutRecipient === helper.recipient;
	return {
		installed: helper.installed,
		recipient: helper.recipient,
		downloaded,
		downloadedAt:
			downloaded && helper.handedOutAt !== null
				? new Date(helper.handedOutAt * 1000).toISOString()
				: null,
	};
}

/**
 * The Backups tab's key download and upload on an apt-installed server
 * (ADR 0044). The key stays root-only; the root helper hands it over for
 * one download and installs an upload after checking it. The API holds no
 * key file and never logs one. Every route is 404 when BACKUP_KEY_SOCKET is
 * unset, as on a VM a separate host backs up.
 */
export function registerAdminBackupKeyRoutes(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
): void {
	const socketPath = config.BACKUP_KEY_SOCKET;
	// A status read waits for the last download's record, so the page that
	// asks right after a download sees it.
	let marking: Promise<void> = Promise.resolve();

	function off(reply: FastifyReply): boolean {
		if (socketPath) return false;
		sendError(reply, 404, "NOT_FOUND", "Not found.");
		return true;
	}

	function unavailable(reply: FastifyReply, error: unknown) {
		// The message names the socket's failure only; no answer text is in it.
		app.log.warn(
			{ err: error instanceof KeyHelperError ? error.message : "unexpected answer" },
			"backup key helper failed",
		);
		sendError(
			reply,
			503,
			"BACKUP_KEY_UNAVAILABLE",
			"The server's backup key helper did not answer. Check portikus-backup-key.socket on the server.",
		);
	}

	async function readStatus(path: string): Promise<BackupKeyStatus> {
		await marking;
		const { words, rest } = splitAnswer(await askKeyHelper(path, "status"));
		if (words[0] !== "ok") throw new KeyHelperError("the status was refused");
		const parsed = HelperStatus.safeParse(JSON.parse(rest.trim()));
		if (!parsed.success)
			throw new KeyHelperError("the status is not in the expected form");
		return toStatus(parsed.data);
	}

	async function audit(
		adminId: string,
		action: string,
		result: string,
		metadata: Record<string, unknown>,
	) {
		await recordAudit(db, {
			actor: `user:${adminId}`,
			target: "backup-key",
			action,
			result,
			metadata: metadata,
		});
	}

	app.get("/admin/backups/key", adminOnly, async (_request, reply) => {
		if (off(reply) || !socketPath) return;
		try {
			return await readStatus(socketPath);
		} catch (error) {
			return unavailable(reply, error);
		}
	});

	app.post("/admin/backups/key/download", adminOnly, async (request, reply) => {
		if (off(reply) || !socketPath) return;
		const admin = requireUser(request);
		let words: string[];
		let key: string;
		try {
			({ words, rest: key } = splitAnswer(await askKeyHelper(socketPath, "export")));
		} catch (error) {
			return unavailable(reply, error);
		}
		if (words[0] === "error" && words[1] === "no-key") {
			return sendError(reply, 404, "NOT_FOUND", "This server has no backup key yet.");
		}
		const recipient = BackupRecipient.safeParse(words[1]);
		if (words[0] !== "ok" || !recipient.success || !IDENTITY.test(key)) {
			return unavailable(
				reply,
				new KeyHelperError("the key is not in the expected form"),
			);
		}
		// Audited before the key leaves; the key itself is never recorded.
		await audit(admin.id, "backup.key_downloaded", "ok", { recipient: recipient.data });
		// The reminder clears only once the whole file has gone out, so a
		// download that fails on its way leaves it showing.
		const held = recipient.data;
		reply.raw.once("finish", () => {
			marking = askKeyHelper(socketPath, `mark-downloaded ${held}`)
				.then((answer) => {
					if (!answer.startsWith("ok"))
						throw new KeyHelperError("the record was refused");
				})
				.catch((error: unknown) => {
					app.log.warn(
						{
							err:
								error instanceof KeyHelperError ? error.message : "unexpected answer",
						},
						"backup key helper did not record the download",
					);
				});
		});
		return reply
			.header("cache-control", "no-store")
			.header("content-disposition", `attachment; filename="${BACKUP_KEY_FILE_NAME}"`)
			.header("x-content-type-options", "nosniff")
			.type("text/plain; charset=utf-8")
			.send(key);
	});

	// Answers a key helper "error <reason>" reply to an upload.
	async function refuseUpload(reply: FastifyReply, adminId: string, reason: string) {
		if (reason === "invalid" || reason === "too-large") {
			await audit(adminId, "backup.key_uploaded", "refused", { reason });
			return sendError(
				reply,
				400,
				"BACKUP_KEY_INVALID",
				"That file is not a backup key. Choose the portikus-backup-key.txt you downloaded.",
			);
		}
		if (reason === "exists") {
			await audit(adminId, "backup.key_uploaded", "refused", { reason });
			return sendError(
				reply,
				409,
				"BACKUP_KEY_EXISTS",
				"This server already has a different backup key. Confirm to replace it.",
			);
		}
		if (reason === "busy") {
			return sendError(
				reply,
				409,
				"BACKUP_RUNNING",
				"A backup is running. Upload the key when it ends.",
			);
		}
		return unavailable(reply, new KeyHelperError(`the upload was refused (${reason})`));
	}

	app.post("/admin/backups/key", adminOnly, async (request, reply) => {
		if (off(reply) || !socketPath) return;
		const admin = requireUser(request);
		const body = BackupKeyUpload.safeParse(request.body ?? {});
		if (!body.success) {
			await audit(admin.id, "backup.key_uploaded", "refused", { reason: "invalid" });
			return sendError(
				reply,
				400,
				"BACKUP_KEY_INVALID",
				"That file is not a backup key. Choose the portikus-backup-key.txt you downloaded.",
			);
		}
		const { key, replace } = body.data;
		let words: string[];
		try {
			({ words } = splitAnswer(
				await askKeyHelper(socketPath, replace ? "import-replace" : "import", key),
			));
		} catch (error) {
			return unavailable(reply, error);
		}
		if (words[0] === "error") {
			return refuseUpload(reply, admin.id, words[1] ?? "unknown");
		}
		const outcome = words[1];
		const recipient = BackupRecipient.safeParse(words[2]);
		if (
			words[0] !== "ok" ||
			(outcome !== "installed" && outcome !== "unchanged") ||
			!recipient.success
		) {
			return unavailable(
				reply,
				new KeyHelperError("the upload answer is not in the expected form"),
			);
		}
		const replaced = BackupRecipient.safeParse(words[3]);
		const replacedRecipient =
			outcome === "installed" && replaced.success ? replaced.data : null;
		await audit(admin.id, "backup.key_uploaded", "ok", {
			recipient: recipient.data,
			outcome,
			replacedRecipient,
		});
		let status: BackupKeyStatus;
		try {
			status = await readStatus(socketPath);
		} catch (error) {
			return unavailable(reply, error);
		}
		const result: BackupKeyUploadResult = { outcome, replacedRecipient, key: status };
		return result;
	});
}
