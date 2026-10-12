import {
	type DexApi,
	type DexPassword,
	generateDexPassword,
	hashDexPassword,
	localDexUserId,
} from "@portikus/auth";
import type { UpdateDexUserRequest } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { recordAudit } from "@portikus/db";
import type { Kysely } from "kysely";
import type { AdminSender } from "../account-email/admin-send.js";
import { emailChangedMessage } from "../account-email/messages.js";
import { accountEmailEnabled } from "../account-email/send.js";
import { revokeAccountEmailTokens } from "../account-email/tokens.js";
import { endSessions } from "../sessions/end-sessions.js";
import { viaDex } from "./dex-accounts.js";

/**
 * The Dex passwords of a Portikus account, found by the user ID in its
 * subject so a changed email cannot point at someone else's password. An
 * interrupted email change can leave none or two for one user ID.
 */
export async function findDexPasswords(db: Kysely<Database>, dex: DexApi, id: string) {
	const account = await db
		.selectFrom("users")
		.select(["oidc_issuer", "oidc_subject", "email", "preferred_username"])
		.where("id", "=", id)
		.executeTakeFirst();
	if (!account) return { found: "no_account" } as const;
	const userId = localDexUserId(account);
	if (userId === null) return { found: "not_local" } as const;
	const all = await viaDex(dex.listPasswords());
	const mine = all.filter((p) => p.userId === userId);
	// The one matching the account's email, when there is one.
	const current: DexPassword | undefined =
		mine.find((p) => p.email === account.email) ?? mine[0];
	return { found: "yes", account, userId, all, mine, current } as const;
}

/**
 * Delete every password of the user ID under another email, then make or
 * refresh the one under `email` with a fresh password, which is returned.
 * Null when another user ID took the email meanwhile.
 */
async function moveDexPassword(
	dex: DexApi,
	input: { mine: DexPassword[]; userId: string; email: string; username: string },
): Promise<string | null> {
	const { mine, userId, email, username } = input;
	const password = generateDexPassword();
	const hash = await hashDexPassword(password);
	for (const p of mine) {
		if (p.email !== email) await viaDex(dex.deletePassword(p.email));
	}
	const kept = mine.find((p) => p.email === email);
	if (!kept) {
		const made = await viaDex(dex.createPassword({ email, username, userId, hash }));
		return made === "already_exists" ? null : password;
	}
	// A retry after the create: give it the new password and username.
	await viaDex(dex.updatePassword(email, hash));
	if (kept.username !== username) await viaDex(dex.updateUsername(email, username));
	return password;
}

/**
 * Give a Dex user a new email, username, or both, keeping the user ID and
 * so the Portikus account and workspace (SPEC.md section 5.1). A username
 * changes in place and keeps the password. Dex cannot change a password's
 * email, so the old password is deleted and a new one made under the same
 * user ID with a fresh password. A failure between the two leaves no
 * password, which fails closed, and a retry finishes the change. Throws
 * DexCallFailed when Dex cannot be reached.
 */
export async function editDexUser(
	ctx: { db: Kysely<Database>; dex: DexApi; sender: AdminSender; publicUrl: string },
	input: {
		id: string;
		actorId: string;
		body: UpdateDexUserRequest;
		metadata: Record<string, unknown>;
	},
): Promise<
	"no_account" | "not_local" | "exists" | { password: string | null; emailed: boolean }
> {
	const { db, dex, sender } = ctx;
	const { id, body } = input;
	const found = await findDexPasswords(db, dex, id);
	if (found.found !== "yes") return found.found;
	const { account, userId, all, mine, current } = found;
	// No password and no new email: nothing to finish a change with.
	if (!current && !body.email) return "not_local";

	const oldEmail = current?.email ?? account.email ?? "";
	const email = body.email ?? oldEmail;
	const username =
		body.username ?? current?.username ?? account.preferred_username ?? "";
	const emailChanged =
		!current || email !== account.email || mine.some((p) => p.email !== email);
	const usernameChanged =
		username !== current?.username || username !== account.preferred_username;
	if (!emailChanged && !usernameChanged) return { password: null, emailed: false };
	if (emailChanged && all.some((p) => p.email === email && p.userId !== userId)) {
		return "exists";
	}

	let password: string | null = null;
	if (emailChanged) {
		password = await moveDexPassword(dex, { mine, userId, email, username });
		if (password === null) return "exists";
	} else if (current && current.username !== username) {
		await viaDex(dex.updateUsername(current.email, username));
	}

	await db.transaction().execute(async (trx) => {
		await trx
			.updateTable("users")
			.set({
				email,
				preferred_username: username,
				...(emailChanged ? { must_change_password: true } : {}),
			})
			.where("id", "=", id)
			.execute();
		if (emailChanged) {
			await endSessions(trx, id);
			await revokeAccountEmailTokens(trx, id);
		}
		// Which fields changed, never the addresses or names (SPEC.md section 24.8).
		await recordAudit(trx, {
			actor: `user:${input.actorId}`,
			target: id,
			action: "dex_user.updated",
			result: "ok",
			metadata: {
				fields: [
					...(emailChanged ? ["email"] : []),
					...(usernameChanged ? ["username"] : []),
				],
				...input.metadata,
			},
		});
	});

	if (!emailChanged || !(await accountEmailEnabled(db))) {
		return { password, emailed: false };
	}
	const sent = await sender.setPasswordLink({
		userId: id,
		actorId: input.actorId,
		purpose: "invite",
		to: email,
	});
	if (oldEmail && oldEmail !== email) {
		// Best effort: the change has happened whether or not the old address hears of it.
		await sender.notice(oldEmail, emailChangedMessage(ctx.publicUrl));
	}
	// A failed send still shows the password, so the person is not left without one.
	return sent === "sent"
		? { password: null, emailed: true }
		: { password, emailed: false };
}
