import type { WebSocket } from "@fastify/websocket";
import { loadSession, sessionGate } from "@portikus/auth";
import {
	type ApiError,
	AssistantClientMessage,
	type AssistantStatus,
	CloseCode,
	type ConversationList,
	CreateConversationRequest,
	MAX_CHAT_CLIENT_FRAME_BYTES,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { openModelClient } from "../ai/settings.js";
import { createAssistantHub } from "../assistant/hub.js";
import {
	createAssistantLoop,
	notEnabledMessage,
	type TurnCaller,
} from "../assistant/loop.js";
import { startAssistantRetention } from "../assistant/retention.js";
import {
	createConversation,
	deleteConversation,
	listConversations,
	ownConversation,
	toSummary,
} from "../assistant/store.js";
import type { AssistantRole } from "../assistant/tools.js";
import { teachesCourse } from "../courses/membership.js";
import type { ServerDeps } from "../deps.js";
import { parseFieldsOr400, sendError, UuidParam } from "../http.js";
import { createSocketSlots } from "../workspaces/socket-slots.js";

/** Open assistant sockets per person, across every tab and conversation. */
const MAX_SOCKETS_PER_USER = 10;

function isStaff(role: string | undefined): role is AssistantRole {
	return role === "administrator" || role === "instructor";
}

/**
 * Administrators and instructors in a signed-in browser only (SPEC.md
 * sections 20.4 and 24.1). The routes are on the catalog's not-exposed list,
 * so the key gate already refuses a key; this holds even if that changed.
 */
async function staffSession(request: FastifyRequest, reply: FastifyReply) {
	if (request.apiKey || !request.sessionToken) {
		const body: ApiError = {
			code: "NOT_AVAILABLE_TO_API_KEYS",
			message: "The assistant is used from a signed-in browser.",
		};
		return reply.status(403).send(body);
	}
	if (!isStaff(request.user?.role)) {
		return sendError(
			reply,
			403,
			"FORBIDDEN",
			"Only administrators and instructors use the assistant.",
		);
	}
}

const NOT_FOUND_MESSAGE = "Conversation not found";

/**
 * The built-in assistant (SPEC.md section 20.4): its status, a person's own
 * conversations, and one WebSocket per conversation that speaks the chat's
 * wire events. A conversation that is not the caller's answers 404.
 */
export function registerAssistantRoutes(app: FastifyInstance, deps: ServerDeps): void {
	const { db, config, logger } = deps;
	const hub = createAssistantHub(db);
	const loop = createAssistantLoop({
		app,
		db,
		hub,
		log: logger,
		openModel: () => openModelClient(db, config),
	});
	const sockets = createSocketSlots(MAX_SOCKETS_PER_USER);
	const staffOnly = { preHandler: staffSession };

	let stopRetention: (() => Promise<void>) | undefined;
	app.addHook("onReady", async () => {
		stopRetention = startAssistantRetention({ db, hub, logger });
	});
	app.addHook("onClose", async () => {
		hub.abortAll();
		await stopRetention?.();
	});

	app.get("/assistant/status", staffOnly, async () => {
		const opened = await openModelClient(db, config);
		const status: AssistantStatus =
			"unavailable" in opened
				? { enabled: false, reason: opened.unavailable }
				: { enabled: true, reason: null };
		return status;
	});

	app.post("/assistant/conversations", staffOnly, async (request, reply) => {
		const body = parseFieldsOr400(CreateConversationRequest, request.body ?? {}, reply);
		if (!body) return reply;
		const user = request.user;
		if (!user) return reply;
		if (body.courseId !== undefined) {
			const known =
				user.role === "administrator"
					? await db
							.selectFrom("lti_contexts")
							.select("id")
							.where("id", "=", body.courseId)
							.executeTakeFirst()
					: (await teachesCourse(db, { userId: user.id, courseId: body.courseId })) ||
						undefined;
			if (!known) return sendError(reply, 404, "NOT_FOUND", "Course not found");
		}
		const opened = await openModelClient(db, config);
		if ("unavailable" in opened) {
			return reply.status(409).send({
				code: "AI_NOT_ENABLED",
				message: notEnabledMessage(opened.unavailable),
				reason: opened.unavailable,
			});
		}
		const row = await createConversation(db, {
			userId: user.id,
			courseId: body.courseId ?? null,
			context: body.context ?? null,
			// A Diagnose conversation looks and reports; it never changes anything.
			readOnly: body.context !== undefined,
		});
		return reply.status(201).send(toSummary(row));
	});

	app.get("/assistant/conversations", staffOnly, async (request) => {
		const user = request.user;
		const rows = user ? await listConversations(db, user.id) : [];
		const list: ConversationList = { conversations: rows.map(toSummary) };
		return list;
	});

	app.delete("/assistant/conversations/:id", staffOnly, async (request, reply) => {
		const params = UuidParam.safeParse(request.params);
		const user = request.user;
		if (
			!params.success ||
			!user ||
			!(await deleteConversation(db, user.id, params.data.id))
		) {
			return sendError(reply, 404, "NOT_FOUND", NOT_FOUND_MESSAGE);
		}
		hub.closeAll(params.data.id, CloseCode.NOT_FOUND, "conversation deleted");
		return reply.status(204).send();
	});

	app.get(
		"/assistant/conversations/:id/socket",
		{
			websocket: true,
			// A HEAD twin would reach the socket handler and crash.
			exposeHeadRoute: false,
			preHandler: [
				staffSession,
				// Refused before the upgrade, like the other sockets.
				async (request, reply) => {
					const params = UuidParam.safeParse(request.params);
					const user = request.user;
					const own =
						params.success && user
							? await ownConversation(db, user.id, params.data.id)
							: undefined;
					if (!own) return sendError(reply, 404, "NOT_FOUND", NOT_FOUND_MESSAGE);
				},
			],
		},
		async (socket: WebSocket, request: FastifyRequest) => {
			const params = UuidParam.parse(request.params);
			const user = request.user;
			const sessionToken = request.sessionToken;
			const conversation = user
				? await ownConversation(db, user.id, params.id)
				: undefined;
			if (!user || !sessionToken || !conversation) {
				socket.close(CloseCode.NOT_FOUND, "conversation not found");
				return;
			}
			if (!sockets.take(user.id)) {
				socket.close(CloseCode.TOO_MANY_SOCKETS, "too many connections");
				return;
			}
			const id = conversation.id;
			const token: string = sessionToken;
			const userAgent = request.headers["user-agent"];

			/** The caller for this frame, or null when the session no longer may use the assistant. */
			async function callerNow(): Promise<TurnCaller | null> {
				const now = await loadSession(db, token);
				if (!now || now.id !== conversation?.user_id || !isStaff(now.role)) return null;
				if (sessionGate(now)) return null;
				return {
					conversationId: id,
					userId: now.id,
					tools: { role: now.role, readOnly: conversation.read_only },
					run: {
						kind: "assistant",
						sessionToken: token,
						ip: request.ip,
						...(userAgent === undefined ? {} : { userAgent }),
					},
				};
			}

			async function handle(text: string): Promise<void> {
				let json: unknown;
				try {
					json = JSON.parse(text);
				} catch {
					return;
				}
				const message = AssistantClientMessage.safeParse(json);
				if (!message.success) return;
				const caller = await callerNow();
				if (!caller) {
					socket.close(CloseCode.SESSION_ENDED, "session ended");
					return;
				}
				const frame = message.data;
				if (frame.type === "send") await loop.send(caller, frame.text);
				else if (frame.type === "permission.answer") await loop.answer(caller, frame);
				else loop.interrupt(caller);
			}

			socket.on("message", (data, isBinary) => {
				if (isBinary) {
					socket.close(1003, "text frames only");
					return;
				}
				const text = data.toString();
				if (Buffer.byteLength(text) > MAX_CHAT_CLIENT_FRAME_BYTES) {
					socket.close(1009, "frame too large");
					return;
				}
				void handle(text).catch((error: unknown) => {
					request.log.error(
						{
							conversationId: id,
							error: error instanceof Error ? error.name : "unknown",
						},
						"assistant socket frame failed",
					);
				});
			});
			socket.on("close", () => {
				hub.detach(id, socket);
				sockets.release(user.id);
			});
			await hub.attach(id, socket);
			// Closed while the history was being sent: the close handler ran first.
			if (socket.readyState !== socket.OPEN) hub.detach(id, socket);
		},
	);
}
