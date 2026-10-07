import {
	type AuthenticationResponseJSON,
	base32Encode,
	checkPasskey,
	checkSecondFactor,
	createChallengeStore,
	enrolTotp,
	generateTotpSecret,
	hashSessionToken,
	isRecoveryCodeShape,
	listPasskeys,
	markSecondFactorPassed,
	matchTotp,
	openPendingTotp,
	otpauthUri,
	passkeyAuthenticationOptions,
	passkeyRegistrationOptions,
	type RegistrationResponseJSON,
	relyingParty,
	replaceRecoveryCodes,
	requireUser,
	sealPendingTotp,
	secondFactorKey,
	sessionOrigin,
	storeFactor,
	useRecoveryCode,
	verifyPasskeyRegistration,
} from "@portikus/auth";
import {
	PasskeyEnrolConfirm,
	type PasskeyOptions,
	PasskeyVerify,
	SecondFactorRename,
	type SecondFactorStatus,
	SecondFactorVerify,
	TotpEnrolConfirm,
	type TotpEnrolDone,
	type TotpEnrolStart,
} from "@portikus/contracts";
import { recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import qrcode from "qrcode-generator";
import type { ZodType } from "zod";
import type { ServerDeps } from "../deps.js";
import { parseOr400, sendError, UuidParam } from "../http.js";
import type {
	SecondFactorAllowance,
	SecondFactorThrottle,
} from "../second-factor-throttle.js";
import { requestMetadata } from "../sessions/start-session.js";

const ISSUER_NAME = "Portikus";

/** The QR code an authenticator app scans, as an SVG data URL. */
function qrDataUrl(text: string): string {
	const qr = qrcode(0, "M");
	qr.addData(text);
	qr.make();
	const svg = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** The body, or a 400 naming the first broken rule; Zod's messages never echo the value. */
function parseBody<T>(
	schema: ZodType<T>,
	body: unknown,
	reply: FastifyReply,
): T | null {
	const parsed = schema.safeParse(body ?? {});
	if (parsed.success) return parsed.data;
	sendError(
		reply,
		400,
		"VALIDATION_FAILED",
		parsed.error.issues[0]?.message ?? "Invalid request",
	);
	return null;
}

/**
 * Two-step sign-in for Dex local-password accounts (SPEC.md section
 * 24.13): enrol an authenticator app, verify a code at sign-in, list and
 * remove one's own factors. Neither a secret nor a code is ever logged
 * or audited.
 */
export function registerMeSecondFactorRoutes(
	app: FastifyInstance,
	deps: ServerDeps,
	throttle: SecondFactorThrottle,
): void {
	const { db, config } = deps;
	const key = secondFactorKey(config.SECOND_FACTOR_KEY);
	const host = new URL(config.PUBLIC_URL).hostname;
	const rp = relyingParty(config.PUBLIC_URL);
	const challenges = createChallengeStore();

	/** The session id, the token's hash; every route here runs signed in. */
	function sessionId(request: FastifyRequest): string {
		return hashSessionToken(request.sessionToken as string);
	}

	/**
	 * Refuse a course launch: it skips the check, so it may never change what
	 * the check asks (SPEC.md section 24.13). Returns whether it refused.
	 */
	async function refuseLaunch(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<boolean> {
		if (requireUser(request).secondFactorApplies) return false;
		const origin = await sessionOrigin(db, sessionId(request));
		if (origin?.method !== "lti") return false;
		sendError(
			reply,
			403,
			"FORBIDDEN",
			"Two-step sign-in cannot be changed from a session opened through your course. Sign in to Portikus with your password to change it.",
		);
		return true;
	}

	/** Only a session the check covers may add factors or recovery codes; on a refusal the reply is sent. */
	async function mayManage(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<boolean> {
		if (requireUser(request).secondFactorApplies) return true;
		if (!(await refuseLaunch(request, reply))) notLocal(reply);
		return false;
	}

	function notLocal(reply: FastifyReply) {
		return sendError(
			reply,
			400,
			"NOT_LOCAL_PASSWORD",
			"Two-step sign-in is for accounts that sign in with a Portikus password.",
		);
	}

	/** Adding a factor needs a session that passed the check, or one with nothing to pass yet. */
	function verifyFirst(reply: FastifyReply) {
		return sendError(
			reply,
			403,
			"SECOND_FACTOR_REQUIRED",
			"Enter a code from your authenticator app first.",
		);
	}

	app.get("/me/second-factor", async (request, reply) => {
		const user = requireUser(request);
		if (!user.secondFactorApplies) return notLocal(reply);
		const factors = await db
			.selectFrom("user_second_factors")
			.select(["id", "kind", "label", "created_at", "last_used_at"])
			.where("user_id", "=", user.id)
			.orderBy("created_at")
			.execute();
		const left = await db
			.selectFrom("user_recovery_codes")
			.select((eb) => eb.fn.countAll<string>().as("count"))
			.where("user_id", "=", user.id)
			.where("used_at", "is", null)
			.executeTakeFirstOrThrow();
		const body: SecondFactorStatus = {
			factors: factors.map((f) => ({
				id: f.id,
				kind: f.kind,
				label: f.label,
				createdAt: new Date(f.created_at).toISOString(),
				lastUsedAt:
					f.last_used_at === null ? null : new Date(f.last_used_at).toISOString(),
			})),
			recoveryCodesLeft: Number(left.count),
		};
		return reply.header("cache-control", "no-store").send(body);
	});

	app.post("/me/second-factor/totp/start", async (request, reply) => {
		const user = requireUser(request);
		if (!(await mayManage(request, reply))) return reply;
		if (user.secondFactor === "verify") return verifyFirst(reply);
		const secret = generateTotpSecret();
		const uri = otpauthUri(
			secret,
			ISSUER_NAME,
			`${user.email ?? user.displayName} (${host})`,
		);
		const body: TotpEnrolStart = {
			token: sealPendingTotp(key, user.id, secret, Date.now()),
			secret: base32Encode(secret),
			uri,
			qrCode: qrDataUrl(uri),
		};
		return reply.header("cache-control", "no-store").send(body);
	});

	app.post("/me/second-factor/totp", async (request, reply) => {
		const user = requireUser(request);
		if (!(await mayManage(request, reply))) return reply;
		if (user.secondFactor === "verify") return verifyFirst(reply);
		const input = parseBody(TotpEnrolConfirm, request.body, reply);
		if (!input) return reply;
		const now = Date.now();
		const secret = openPendingTotp(key, user.id, input.token, now);
		if (!secret) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"This setup has expired. Start again to get a new code.",
			);
		}
		const step = matchTotp(secret, input.code, now, null);
		if (step === null) {
			return sendError(
				reply,
				403,
				"WRONG_CODE",
				"That code is not right. Check that your phone's clock is set automatically, then try the newest code.",
			);
		}
		const recoveryCodes = await enrolTotp(db, key, {
			userId: user.id,
			secret,
			label: input.label,
			step,
			sessionId: sessionId(request),
			actor: `user:${user.id}`,
			metadata: requestMetadata(request),
		});
		const body: TotpEnrolDone = { recoveryCodes };
		return reply.header("cache-control", "no-store").send(body);
	});

	async function auditFailure(
		request: FastifyRequest,
		userId: string,
		extra: Record<string, unknown>,
	): Promise<void> {
		await recordAudit(db, {
			actor: `user:${userId}`,
			target: userId,
			action: "auth.second_factor_failed",
			result: "failed",
			metadata: { ...requestMetadata(request), ...extra },
		});
	}

	/** Audit metadata that marks a try let past a refused count (ADR 0053). */
	function bypassMark(allowance: SecondFactorAllowance): Record<string, unknown> {
		return allowance.kind === "bypass" ? { bypass: true } : {};
	}

	async function passed(
		request: FastifyRequest,
		userId: string,
		allowance: SecondFactorAllowance,
		extra: Record<string, unknown>,
	): Promise<void> {
		// A bypass holds no receipt, so nothing on that path gives a count back.
		if (allowance.kind === "counted") await throttle.giveBack(allowance.receipt);
		const metadata = {
			...requestMetadata(request),
			...extra,
			...bypassMark(allowance),
		};
		await db.transaction().execute(async (trx) => {
			await markSecondFactorPassed(trx, sessionId(request));
			await recordAudit(trx, {
				actor: `user:${userId}`,
				target: userId,
				action: "auth.second_factor_verified",
				result: "ok",
				metadata,
			});
		});
	}

	function setUpFirst(reply: FastifyReply) {
		return sendError(reply, 400, "VALIDATION_FAILED", "Set up two-step sign-in first.");
	}

	app.post("/me/second-factor/verify", async (request, reply) => {
		const user = requireUser(request);
		if (user.secondFactor === null) return reply.status(204).send();
		if (user.secondFactor === "enrol") return setUpFirst(reply);
		const input = parseBody(SecondFactorVerify, request.body, reply);
		if (!input) return reply;
		const allowance = await throttle.allow(request, reply, user.id, {
			sessionId: sessionId(request),
			eligible: isRecoveryCodeShape(input.code),
			// Offer a passkey only to someone who has one (SPEC.md section 25.8).
			passkeys: (await listPasskeys(db, user.id)).length > 0,
		});
		if (!allowance) return reply;

		// Past a refused count only recovery codes are checked, never app codes.
		const result =
			allowance.kind === "counted"
				? await checkSecondFactor(db, key, user.id, input.code)
				: await useRecoveryCode(db, user.id, input.code);
		if (!result.ok) {
			await auditFailure(request, user.id, bypassMark(allowance));
			return sendError(
				reply,
				403,
				"WRONG_CODE",
				"That code is not right. Try the newest code from your app, or a recovery code.",
			);
		}
		await passed(request, user.id, allowance, { method: result.method });
		return reply.status(204).send();
	});

	/** A ceremony's challenge key: one per session and purpose, so a challenge only answers its own ceremony. */
	function challengeKey(
		request: FastifyRequest,
		purpose: "register" | "verify",
	): string {
		return `${sessionId(request)}:${purpose}`;
	}

	function expired(reply: FastifyReply) {
		return sendError(
			reply,
			400,
			"PASSKEY_EXPIRED",
			"That took too long. Try your passkey again.",
		);
	}

	app.post("/me/second-factor/webauthn/start", async (request, reply) => {
		const user = requireUser(request);
		if (!(await mayManage(request, reply))) return reply;
		if (user.secondFactor === "verify") return verifyFirst(reply);
		const existing = await listPasskeys(db, user.id);
		const options = await passkeyRegistrationOptions(
			rp,
			{
				id: user.id,
				name: user.email ?? user.displayName,
				displayName: user.displayName,
			},
			existing.map((p) => p.passkey),
		);
		challenges.put(challengeKey(request, "register"), options.challenge);
		const body: PasskeyOptions = { ...options };
		return reply.header("cache-control", "no-store").send(body);
	});

	app.post("/me/second-factor/webauthn", async (request, reply) => {
		const user = requireUser(request);
		if (!(await mayManage(request, reply))) return reply;
		if (user.secondFactor === "verify") return verifyFirst(reply);
		const input = parseBody(PasskeyEnrolConfirm, request.body, reply);
		if (!input) return reply;
		const challenge = challenges.take(challengeKey(request, "register"));
		if (challenge === null) return expired(reply);
		const result = await verifyPasskeyRegistration(
			rp,
			input.credential as unknown as RegistrationResponseJSON,
			challenge,
		);
		if (!result) {
			return sendError(
				reply,
				403,
				"WRONG_PASSKEY",
				"The passkey could not be checked. Try again.",
			);
		}
		const recoveryCodes = await storeFactor(db, {
			userId: user.id,
			kind: "webauthn",
			secret: JSON.stringify(result.passkey),
			label: input.label,
			lastStep: result.counter,
			sessionId: sessionId(request),
			actor: `user:${user.id}`,
			metadata: requestMetadata(request),
		});
		const body: TotpEnrolDone = { recoveryCodes };
		return reply.header("cache-control", "no-store").send(body);
	});

	app.post("/me/second-factor/webauthn/verify/start", async (request, reply) => {
		const user = requireUser(request);
		if (user.secondFactor !== "verify") return setUpFirst(reply);
		const passkeys = await listPasskeys(db, user.id);
		if (passkeys.length === 0) {
			return sendError(
				reply,
				400,
				"NO_PASSKEY",
				"This account has no passkey. Use your authenticator app or a recovery code.",
			);
		}
		const options = await passkeyAuthenticationOptions(
			rp,
			passkeys.map((p) => p.passkey),
		);
		challenges.put(challengeKey(request, "verify"), options.challenge);
		const body: PasskeyOptions = { ...options };
		return reply.header("cache-control", "no-store").send(body);
	});

	app.post("/me/second-factor/webauthn/verify", async (request, reply) => {
		const user = requireUser(request);
		if (user.secondFactor === null) return reply.status(204).send();
		if (user.secondFactor === "enrol") return setUpFirst(reply);
		const input = parseBody(PasskeyVerify, request.body, reply);
		if (!input) return reply;
		const allowance = await throttle.allow(request, reply, user.id, {
			sessionId: sessionId(request),
			eligible: true,
			passkeys: true,
		});
		if (!allowance) return reply;
		const challenge = challenges.take(challengeKey(request, "verify"));
		if (challenge === null) {
			// No passkey was checked, so this request's own try is returned.
			if (allowance.kind === "counted") await throttle.giveBack(allowance.receipt);
			return expired(reply);
		}

		const result = await checkPasskey(
			db,
			rp,
			user.id,
			input.credential as unknown as AuthenticationResponseJSON,
			challenge,
		);
		if (!result.ok) {
			await auditFailure(request, user.id, {
				kind: "webauthn",
				reason: result.reason,
				...bypassMark(allowance),
			});
			return sendError(
				reply,
				403,
				"WRONG_PASSKEY",
				"That passkey did not work. Try again, or use your authenticator app or a recovery code.",
			);
		}
		await passed(request, user.id, allowance, {
			method: "webauthn",
			kind: "webauthn",
			factorId: result.factorId,
		});
		return reply.status(204).send();
	});

	app.patch("/me/second-factor/:id", async (request, reply) => {
		const user = requireUser(request);
		if (await refuseLaunch(request, reply)) return reply;
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return reply;
		const input = parseBody(SecondFactorRename, request.body, reply);
		if (!input) return reply;
		const renamed = await db
			.updateTable("user_second_factors")
			.set({ label: input.label })
			.where("id", "=", params.id)
			.where("user_id", "=", user.id)
			.executeTakeFirst();
		if (renamed.numUpdatedRows === 0n) {
			return sendError(reply, 404, "NOT_FOUND", "Not found.");
		}
		return reply.status(204).send();
	});

	app.post("/me/second-factor/recovery-codes", async (request, reply) => {
		const user = requireUser(request);
		if (!(await mayManage(request, reply))) return reply;
		const recoveryCodes = await replaceRecoveryCodes(
			db,
			user.id,
			`user:${user.id}`,
			requestMetadata(request),
		);
		if (recoveryCodes === null) return setUpFirst(reply);
		const body: TotpEnrolDone = { recoveryCodes };
		return reply.header("cache-control", "no-store").send(body);
	});

	app.delete("/me/second-factor/:id", async (request, reply) => {
		const user = requireUser(request);
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return reply;
		if (await refuseLaunch(request, reply)) return reply;
		const removed = await db.transaction().execute(async (trx) => {
			// Lock the account's factors so two removals cannot both leave none.
			const factors = await trx
				.selectFrom("user_second_factors")
				.select(["id", "kind"])
				.where("user_id", "=", user.id)
				.forUpdate()
				.execute();
			const factor = factors.find((f) => f.id === params.id);
			if (!factor) return "missing" as const;
			// Only a Dex local-password account has factors, and it always keeps one (SPEC.md section 24.13).
			if (factors.length === 1) return "last" as const;
			await trx.deleteFrom("user_second_factors").where("id", "=", params.id).execute();
			await recordAudit(trx, {
				actor: `user:${user.id}`,
				target: user.id,
				action: "auth.second_factor_removed",
				result: "ok",
				metadata: {
					...requestMetadata(request),
					factorId: params.id,
					kind: factor.kind,
				},
			});
			return "removed" as const;
		});
		if (removed === "missing") return sendError(reply, 404, "NOT_FOUND", "Not found.");
		if (removed === "last") {
			return sendError(
				reply,
				409,
				"LAST_SECOND_FACTOR",
				"Add another way to sign in before you remove this one.",
			);
		}
		return reply.status(204).send();
	});
}
