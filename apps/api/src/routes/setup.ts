import {
	claimSetupCode,
	grantAdministrator,
	hasEnabledAdministrator,
	hashDexPassword,
	hashSessionToken,
	isCourseIssuer,
	precreateDexAccount,
	requireUser,
	sessionOrigin,
} from "@portikus/auth";
import {
	ClaimSetupCodeRequest,
	FirstAccountRequest,
	type SetupState,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerDeps } from "../server.js";
import { createSetupThrottle } from "../signin-throttle.js";
import { sendError } from "./admin.js";
import { audit, requestMetadata } from "./start-session.js";

const INVALID_CODE = "That code is not valid.";

/** Thrown inside a transaction to roll it back without a reply yet. */
class Refused extends Error {
	constructor(
		readonly reason: "code" | "course_account" | "admin_exists" | "dex_user_exists",
	) {
		super(reason);
	}
}

/**
 * The first administrator (docs/EPIC-14.md rulings 15 to 18; ADR 0028). A
 * signed-in SSO account claims the setup code; under standalone Dex, while
 * no administrator exists, the code also creates the first account. The
 * code itself is never logged or audited.
 */
export function registerSetupRoutes(app: FastifyInstance, deps: ServerDeps): void {
	const { db, config } = deps;
	const throttle = createSetupThrottle();

	/** Count one attempt; answer 429 and return false when the address is over. */
	async function withinLimit(request: FastifyRequest, reply: FastifyReply) {
		const decision = throttle.check(request.ip);
		if (decision.allowed) return true;
		if (decision.audit) {
			await audit(db, "auth.throttled", "unknown", "unknown", "denied", {
				ip: request.ip,
				scope: "setup",
			});
		}
		sendError(
			reply,
			429,
			"RATE_LIMITED",
			"Too many setup attempts. Please wait a few minutes and try again.",
		);
		return false;
	}

	async function firstAccountOpen(): Promise<boolean> {
		return deps.dex !== undefined && !(await hasEnabledAdministrator(db));
	}

	// GET /setup/state -- whether /setup offers the first-account form (ruling 18).
	app.get("/setup/state", async () => {
		const body: SetupState = { firstAccount: await firstAccountOpen() };
		return body;
	});

	// POST /setup/claim -- a signed-in SSO account becomes administrator (ruling 17).
	app.post("/setup/claim", async (request, reply) => {
		const user = requireUser(request);
		if (!(await withinLimit(request, reply))) return reply;
		const body = ClaimSetupCodeRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}
		// A launch session is a course sign-in, even for a linked SSO account.
		const origin = await sessionOrigin(
			db,
			hashSessionToken(request.sessionToken as string),
		);
		if (origin?.method !== "oidc") {
			return sendError(
				reply,
				403,
				"FORBIDDEN",
				"Sign in with your SSO account to use a setup code.",
			);
		}
		const actor = `user:${user.id}`;
		try {
			await db.transaction().execute(async (trx) => {
				// The account first: a course account must not use up the code.
				const target = await trx
					.selectFrom("users")
					.select("oidc_issuer")
					.where("id", "=", user.id)
					.executeTakeFirstOrThrow();
				if (isCourseIssuer(target.oidc_issuer)) throw new Refused("course_account");
				if (!(await claimSetupCode(trx, body.data.code, user.id))) {
					throw new Refused("code");
				}
				const granted = await grantAdministrator(trx, user.id);
				if (!granted.ok) throw new Error("the claimer's account vanished");
				await audit(trx, "setup.code_claimed", actor, user.id, "ok", {
					...requestMetadata(request),
				});
				if (granted.changed) {
					await audit(trx, "user.role_changed", actor, user.id, "ok", {
						from: granted.from,
						to: granted.to,
						source: "setup",
						...requestMetadata(request),
					});
				}
			});
		} catch (err) {
			if (!(err instanceof Refused)) throw err;
			if (err.reason === "code") {
				await audit(db, "setup.code_claimed", actor, user.id, "failed", {
					...requestMetadata(request),
				});
				return sendError(reply, 400, "VALIDATION_FAILED", INVALID_CODE);
			}
			return sendError(
				reply,
				403,
				"FORBIDDEN",
				"A course account cannot become an administrator.",
			);
		}
		return reply.status(204).send();
	});

	// POST /setup/first-account -- the first Dex password and its administrator (ruling 18).
	app.post("/setup/first-account", async (request, reply) => {
		const dex = deps.dex;
		if (!dex || !(await firstAccountOpen())) {
			return sendError(reply, 404, "NOT_FOUND", "Not found.");
		}
		if (!(await withinLimit(request, reply))) return reply;
		const body = FirstAccountRequest.safeParse(request.body ?? {});
		if (!body.success) {
			return sendError(reply, 400, "VALIDATION_FAILED", body.error.message);
		}
		const { email, username, password, code } = body.data;
		const dexUserId = crypto.randomUUID();
		const hash = await hashDexPassword(password);

		let dexCreated = false;
		try {
			// The code, the account and the Dex password commit together, or none do.
			await db.transaction().execute(async (trx) => {
				if (await hasEnabledAdministrator(trx)) throw new Refused("admin_exists");
				const id = await precreateDexAccount(trx, config.OIDC_ISSUER_URL, {
					userId: dexUserId,
					email,
					username,
					displayName: username,
					role: "administrator",
				});
				// Single use settles a race: only one form can claim the code.
				if (!(await claimSetupCode(trx, code, id))) throw new Refused("code");
				await audit(trx, "setup.code_claimed", `user:${id}`, id, "ok", {
					firstAccount: true,
					...requestMetadata(request),
				});
				await audit(trx, "user.role_changed", `user:${id}`, id, "ok", {
					from: null,
					to: "administrator",
					source: "setup",
					...requestMetadata(request),
				});
				const created = await dex.createPassword({
					email,
					username,
					userId: dexUserId,
					hash,
				});
				if (created === "already_exists") throw new Refused("dex_user_exists");
				dexCreated = true;
			});
		} catch (err) {
			if (dexCreated) {
				// The account did not commit: best effort, remove its Dex password.
				await dex.deletePassword(email).catch((cleanupErr: unknown) => {
					const code = (cleanupErr as { code?: unknown }).code;
					request.log.error(
						{ grpcCode: typeof code === "number" ? code : null },
						"dex password left without an account",
					);
				});
			}
			if (err instanceof Refused) {
				if (err.reason === "code") {
					await audit(db, "setup.code_claimed", "unknown", "setup", "failed", {
						firstAccount: true,
						...requestMetadata(request),
					});
					return sendError(reply, 400, "VALIDATION_FAILED", INVALID_CODE);
				}
				if (err.reason === "admin_exists") {
					return sendError(reply, 404, "NOT_FOUND", "Not found.");
				}
				return sendError(
					reply,
					409,
					"DEX_USER_EXISTS",
					"A Dex user with this email already exists.",
				);
			}
			// The gRPC status only: the request carries a password hash.
			const grpcCode = (err as { code?: unknown }).code;
			if (typeof grpcCode === "number") {
				request.log.error({ grpcCode }, "dex call failed");
				return sendError(
					reply,
					503,
					"DEX_UNAVAILABLE",
					"Dex could not be reached. Try again.",
				);
			}
			throw err;
		}
		return reply.status(204).send();
	});
}
