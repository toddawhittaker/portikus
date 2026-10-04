import {
	type DexApi,
	generateDexPassword,
	hashDexPassword,
	precreateDexAccount,
} from "@portikus/auth";
import type { CreateDexUserRequest } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { recordAudit } from "@portikus/db";
import type { FastifyBaseLogger } from "fastify";
import type { Kysely } from "kysely";

/** A failed Dex call, told apart from a database error. */
export class DexCallFailed extends Error {
	constructor(readonly grpcCode: number | null) {
		super("dex call failed");
	}
}

/** Thrown inside a transaction to roll it back when Dex refuses the email. */
class DexEmailTaken extends Error {}

/** Run one Dex call, turning its failure into DexCallFailed. */
export async function viaDex<T>(call: Promise<T>): Promise<T> {
	try {
		return await call;
	} catch (err) {
		const code = (err as { code?: unknown }).code;
		throw new DexCallFailed(typeof code === "number" ? code : null);
	}
}

/**
 * Make a Dex password and its pre-created account together, or neither,
 * with a one-time password the person changes at first sign-in (SPEC.md
 * section 5.2, ADR 0028). Answers "exists" when Dex already has the email.
 * Throws DexCallFailed when Dex cannot be reached. The password is
 * returned, never stored, logged or audited.
 */
export async function createDexAccount(
	ctx: { db: Kysely<Database>; dex: DexApi; issuer: string; log: FastifyBaseLogger },
	input: CreateDexUserRequest & { actorId: string; metadata: Record<string, unknown> },
): Promise<{ id: string; password: string } | "exists"> {
	const { db, dex, issuer, log } = ctx;
	const { email, username, name, role } = input;
	const dexUserId = crypto.randomUUID();
	const password = generateDexPassword();
	const hash = await hashDexPassword(password);
	let dexCreated = false;
	try {
		const id = await db.transaction().execute(async (trx) => {
			const newId = await precreateDexAccount(trx, issuer, {
				userId: dexUserId,
				email,
				username,
				// Dex sends the username as the name claim, so the admin supplies it (SPEC.md section 5.1).
				displayName: name,
				role,
				// The person chooses their own at first sign-in (SPEC.md section 5.2).
				mustChangePassword: true,
			});
			await recordAudit(trx, {
				actor: `user:${input.actorId}`,
				target: newId,
				action: "dex_user.created",
				result: "ok",
				metadata: { role, ...input.metadata },
			});
			const created = await viaDex(
				dex.createPassword({ email, username, userId: dexUserId, hash }),
			);
			if (created === "already_exists") throw new DexEmailTaken();
			dexCreated = true;
			return newId;
		});
		return { id, password };
	} catch (err) {
		if (dexCreated) {
			// Best effort: the account did not commit, so its password must go.
			await dex.deletePassword(email).catch((cause: unknown) => {
				const code = (cause as { code?: unknown }).code;
				log.error(
					{ grpcCode: typeof code === "number" ? code : null },
					"dex password left without an account",
				);
			});
		}
		if (err instanceof DexEmailTaken) return "exists";
		throw err;
	}
}
