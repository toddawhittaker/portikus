import {
	type AuthenticationResponseJSON,
	accountNeedsSecondFactor,
	checkPasskey,
	checkSecondFactor,
	createChallengeStore,
	hashSessionToken,
	isRecoveryCodeShape,
	listPasskeys,
	passkeyAuthenticationOptions,
	relyingParty,
	secondFactorKey,
	useRecoveryCode,
} from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";
import type { ApiError, PasskeyCredential, PasskeyOptions } from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { z } from "zod";
import type { SecondFactorThrottle } from "../second-factor-throttle.js";
import { requestMetadata } from "./start-session.js";

/**
 * A second-factor check inside a signed-in action (SPEC.md section 24.13):
 * an account with a Dex local password proves a code or a passkey again
 * before the action, throttled like the sign-in gate. Other accounts owe
 * nothing. Each flow keeps its own passkey challenges, apart from the
 * gate's, so a challenge made for one never answers another.
 */

/** Which action the check guards; recorded on its audit rows. */
export type StepUpFlow = "link" | "api_key";

interface StepUpProof {
	code?: string | undefined;
	credential?: Credential | undefined;
}

type Credential = z.infer<typeof PasskeyCredential>;

type StepUpResult = "passed" | "not_needed" | "refused";

export interface StepUp {
	/** What the account owes: a check, an enrolment first, or nothing. */
	owed(userId: string): Promise<"verify" | "enrol" | null>;
	hasPasskey(userId: string): Promise<boolean>;
	/** Check the code or passkey; on a refusal the reply is already sent. */
	pass(
		request: FastifyRequest,
		reply: FastifyReply,
		userId: string,
		proof: StepUpProof,
	): Promise<StepUpResult>;
	/** A passkey challenge for this session and account, or null when it has no passkey. */
	startPasskey(request: FastifyRequest, userId: string): Promise<PasskeyOptions | null>;
}

function fail(
	reply: FastifyReply,
	status: number,
	code: ApiError["code"],
	message: string,
) {
	return reply.status(status).send({ code, message });
}

/** The session the request came with, as stored. */
export function sessionIdOf(request: FastifyRequest): string {
	// The auth plugin sets the token with the user, so a signed-in route has it.
	return hashSessionToken(request.sessionToken ?? "");
}

export function createStepUp(
	deps: { db: Kysely<Database>; config: ApiConfig },
	throttle: SecondFactorThrottle,
	options: {
		flow: StepUpFlow;
		/** Shown to an account that must set up a second factor before this action. */
		enrolMessage: string;
	},
): StepUp {
	const { db, config } = deps;
	const { flow } = options;
	const key = secondFactorKey(config.SECOND_FACTOR_KEY);
	const rp = relyingParty(config.PUBLIC_URL);
	const challenges = createChallengeStore();

	/** One challenge per session, flow and account, so it answers only that action. */
	function challengeKey(request: FastifyRequest, userId: string): string {
		return `${sessionIdOf(request)}:${flow}:${userId}`;
	}

	async function hasPasskey(userId: string): Promise<boolean> {
		return (await listPasskeys(db, userId)).length > 0;
	}

	async function owed(userId: string): Promise<"verify" | "enrol" | null> {
		const row = await db
			.selectFrom("users")
			.select(["oidc_issuer", "oidc_subject"])
			.select((eb) =>
				eb
					.exists(
						eb
							.selectFrom("user_second_factors")
							.select("user_second_factors.id")
							.whereRef("user_second_factors.user_id", "=", "users.id"),
					)
					.as("has_factor"),
			)
			.where("id", "=", userId)
			.executeTakeFirst();
		if (!row || !accountNeedsSecondFactor(row)) return null;
		return row.has_factor ? "verify" : "enrol";
	}

	/** An authenticator or recovery code, throttled like the sign-in gate. */
	async function passCode(
		request: FastifyRequest,
		reply: FastifyReply,
		userId: string,
		code: string,
	): Promise<"passed" | "refused"> {
		const allowance = await throttle.allow(request, reply, userId, {
			sessionId: sessionIdOf(request),
			eligible: isRecoveryCodeShape(code),
			passkeys: () => hasPasskey(userId),
		});
		if (!allowance) return "refused";
		const result =
			allowance.kind === "counted"
				? await checkSecondFactor(db, key, userId, code)
				: await useRecoveryCode(db, userId, code);
		await recordAudit(db, {
			actor: `user:${userId}`,
			target: userId,
			action: result.ok ? "auth.second_factor_verified" : "auth.second_factor_failed",
			result: result.ok ? "ok" : "failed",
			metadata: {
				...requestMetadata(request),
				...(result.ok ? { method: result.method } : {}),
				...(allowance.kind === "bypass" ? { bypass: true } : {}),
				flow,
			},
		});
		if (!result.ok) {
			fail(
				reply,
				403,
				"WRONG_CODE",
				"That code is not right. Try the newest code from your app, or a recovery code.",
			);
			return "refused";
		}
		// A bypass holds no receipt, so nothing on that path gives a count back.
		if (allowance.kind === "counted") await throttle.giveBack(allowance.receipt);
		return "passed";
	}

	/** A passkey answer to this session's challenge, checked against this account's passkeys only. */
	async function passPasskey(
		request: FastifyRequest,
		reply: FastifyReply,
		userId: string,
		credential: Credential,
	): Promise<"passed" | "refused"> {
		// As at the gate, a passkey may pass a refused count (ADR 0053).
		const allowance = await throttle.allow(request, reply, userId, {
			sessionId: sessionIdOf(request),
			eligible: true,
			passkeys: async () => true,
		});
		if (!allowance) return "refused";
		const challenge = challenges.take(challengeKey(request, userId));
		if (challenge === null) {
			// No passkey was checked, so this request's own try is returned.
			if (allowance.kind === "counted") await throttle.giveBack(allowance.receipt);
			fail(
				reply,
				400,
				"PASSKEY_EXPIRED",
				"That took too long. Try your passkey again.",
			);
			return "refused";
		}
		const result = await checkPasskey(
			db,
			rp,
			userId,
			credential as unknown as AuthenticationResponseJSON,
			challenge,
		);
		await recordAudit(db, {
			actor: `user:${userId}`,
			target: userId,
			action: result.ok ? "auth.second_factor_verified" : "auth.second_factor_failed",
			result: result.ok ? "ok" : "failed",
			metadata: {
				...requestMetadata(request),
				kind: "webauthn",
				...(result.ok
					? { method: "webauthn", factorId: result.factorId }
					: { reason: result.reason }),
				...(allowance.kind === "bypass" ? { bypass: true } : {}),
				flow,
			},
		});
		if (!result.ok) {
			fail(
				reply,
				403,
				"WRONG_PASSKEY",
				"That passkey did not work. Try again, or use your authenticator app or a recovery code.",
			);
			return "refused";
		}
		if (allowance.kind === "counted") await throttle.giveBack(allowance.receipt);
		return "passed";
	}

	return {
		owed,
		hasPasskey,
		async pass(request, reply, userId, proof) {
			const status = await owed(userId);
			if (status === null) return "not_needed";
			if (status === "enrol") {
				fail(reply, 403, "SECOND_FACTOR_REQUIRED", options.enrolMessage);
				return "refused";
			}
			if (proof.credential !== undefined) {
				return passPasskey(request, reply, userId, proof.credential);
			}
			if (proof.code === undefined) {
				fail(
					reply,
					403,
					"SECOND_FACTOR_REQUIRED",
					"Enter a code from your authenticator app, or a recovery code.",
				);
				return "refused";
			}
			return passCode(request, reply, userId, proof.code);
		},
		async startPasskey(request, userId) {
			const passkeys = await listPasskeys(db, userId);
			if (passkeys.length === 0) return null;
			const passkeyOptions = await passkeyAuthenticationOptions(
				rp,
				passkeys.map((p) => p.passkey),
			);
			challenges.put(challengeKey(request, userId), passkeyOptions.challenge);
			return { ...passkeyOptions };
		},
	};
}
