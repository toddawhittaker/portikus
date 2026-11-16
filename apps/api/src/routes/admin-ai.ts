import { requireRole, requireUser } from "@portikus/auth";
import {
	AcceptNoticeRequest,
	AI_NOTICE_VERSION,
	type AiSettingsView,
	type ModelListResponse,
	ProxyHostsUpdate,
	type TestAiResult,
	UpdateAiSettingsRequest,
} from "@portikus/contracts";
import { recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { addUsage, collectStep } from "../ai/collect.js";
import type { AiTool, StepRequest } from "../ai/model.js";
import {
	type AiSettings,
	loadAiSettings,
	modelClientFor,
	planSettingsUpdate,
	readProxyHosts,
	unlistedHosts,
} from "../ai/settings.js";
import { recordUsage, type StepUsage, usedThisMonth } from "../ai/usage.js";
import type { ServerDeps } from "../deps.js";
import { parseFieldsOr400, sendError } from "../http.js";
import { submitSiteJob } from "../site/submit.js";

const adminOnly = { preHandler: requireRole("administrator") };

// What the settings page's "test" button asks the model. No Portikus data goes in it.
const AI_TEST_TOOL_NAME = "portikus_ping";
const AI_TEST_PROMPT = `Run the ${AI_TEST_TOOL_NAME} check now.`;
const TEST_SYSTEM =
	`You are checking a connection. Call the tool ${AI_TEST_TOOL_NAME} exactly once with ` +
	'{ "word": "pong" }. When it answers, reply with the word it returned and nothing else.';
const TEST_TOOL: AiTool = {
	name: AI_TEST_TOOL_NAME,
	description: "Returns the word it is given.",
	inputSchema: {
		type: "object",
		properties: { word: { type: "string" } },
		required: ["word"],
		additionalProperties: false,
	},
};
const TEST_STEP_MS = 60_000;
const TEST_MAX_OUTPUT_TOKENS = 300;

function hostOf(address: string): string {
	return new URL(address).hostname.toLowerCase();
}

/**
 * The built-in AI settings page's routes (SPEC.md sections 20.4 and 24.8):
 * administrator only, and never reachable with an API key because they carry
 * the provider's key. The key is write-only.
 */
export function registerAdminAiRoutes(
	app: FastifyInstance,
	{ db, config }: ServerDeps,
): void {
	const jobsDir = config.SITE_JOBS_DIR;

	async function view(settings: AiSettings): Promise<AiSettingsView> {
		const { listed } = await readProxyHosts(config);
		return {
			enabled: settings.enabled,
			providerKind: settings.providerKind ?? "openai-compatible",
			baseUrl: settings.baseUrl,
			model: settings.model,
			keySet: settings.keySealed !== null,
			keyHint: settings.keyHint,
			monthlyTokenCap: settings.monthlyTokenCap,
			conversationTokenBudget: settings.conversationTokenBudget,
			noticeVersion: settings.noticeVersion,
			noticeAcceptedAt: settings.noticeAcceptedAt?.toISOString() ?? null,
			noticeAcceptedBy: settings.noticeAcceptedBy,
			usedThisMonth: await usedThisMonth(db),
			priceSources: settings.priceSources,
			hostListed: settings.baseUrl !== null && listed.has(hostOf(settings.baseUrl)),
		};
	}

	app.get("/admin/ai", adminOnly, async (_request, reply) => {
		return reply
			.header("cache-control", "no-store")
			.send(await view(await loadAiSettings(db)));
	});

	/**
	 * Adds the hosts of the saved addresses to the server proxy host list
	 * through the same request the proxy hosts page makes. False means the
	 * reply has been sent: a full list, or a site job already running.
	 */
	async function offerProxyHosts(
		reply: FastifyReply,
		adminId: string,
		addresses: string[],
	): Promise<boolean> {
		if (!jobsDir) return true;
		const { page, listed } = await readProxyHosts(config);
		const missing = unlistedHosts(addresses, listed);
		if (missing.length === 0) return true;
		const next = ProxyHostsUpdate.safeParse({
			hosts: [...new Set([...page, ...missing].map((h) => h.toLowerCase()))],
		});
		if (!next.success) {
			sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"The server proxy host list cannot take these hosts. Remove one on the Egress page first.",
			);
			return false;
		}
		const job = await submitSiteJob(reply, db, jobsDir, `user:${adminId}`, {
			kind: "proxy-hosts",
			hosts: next.data.hosts,
		});
		return job !== null;
	}

	app.put("/admin/ai", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const body = parseFieldsOr400(UpdateAiSettingsRequest, request.body ?? {}, reply);
		if (!body) return reply;
		const current = await loadAiSettings(db);
		const plan = planSettingsUpdate(body, current, config);
		if ("status" in plan) return sendError(reply, plan.status, plan.code, plan.message);

		if (body.addProxyHost === true) {
			const baseUrl = body.baseUrl ?? current.baseUrl;
			const addresses = [
				...(baseUrl ? [baseUrl] : []),
				...(body.priceSources ?? current.priceSources),
			];
			if (!(await offerProxyHosts(reply, admin.id, addresses))) return reply;
		}

		if (plan.changed.length > 0) {
			await db.transaction().execute(async (trx) => {
				await trx
					.updateTable("ai_settings")
					.set({
						...plan.patch,
						updated_at: new Date().toISOString(),
						updated_by: admin.id,
					})
					.where("id", "=", 1)
					.execute();
				await recordAudit(trx, {
					actor: `user:${admin.id}`,
					target: "ai_settings",
					action: "ai_settings.updated",
					result: "ok",
					metadata: {
						changed: plan.changed,
						...(plan.keyChange ? { key: plan.keyChange } : {}),
					},
				});
			});
		}
		return reply
			.header("cache-control", "no-store")
			.send(await view(await loadAiSettings(db)));
	});

	app.post("/admin/ai/notice", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const body = parseFieldsOr400(AcceptNoticeRequest, request.body ?? {}, reply);
		if (!body) return reply;
		if (body.noticeVersion !== AI_NOTICE_VERSION) {
			return sendError(
				reply,
				400,
				"VALIDATION_FAILED",
				"That notice is out of date. Reload the page and read the current one.",
			);
		}
		await db.transaction().execute(async (trx) => {
			const now = new Date().toISOString();
			await trx
				.updateTable("ai_settings")
				.set({
					notice_version: body.noticeVersion,
					notice_accepted_by: admin.id,
					notice_accepted_at: now,
					updated_at: now,
					updated_by: admin.id,
				})
				.where("id", "=", 1)
				.execute();
			await recordAudit(trx, {
				actor: `user:${admin.id}`,
				target: "ai_settings",
				action: "ai.notice_accepted",
				result: "ok",
				metadata: { noticeVersion: body.noticeVersion },
			});
		});
		return reply
			.header("cache-control", "no-store")
			.send(await view(await loadAiSettings(db)));
	});

	// A real tool-call round trip with the saved settings, to show a small model
	// that cannot call tools before anyone relies on it (SPEC.md section 20.4).
	app.post("/admin/ai/test", adminOnly, async (request, reply) => {
		const admin = requireUser(request);
		const found = modelClientFor(await loadAiSettings(db), config);
		const opened = "unavailable" in found ? null : found;
		const total: StepUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		let counted = false;
		const add = (usage: StepUsage | null) => {
			if (!usage) return;
			counted = true;
			addUsage(total, usage);
		};
		const done = async (
			stage: TestAiResult["stage"],
			errorCode: string | null,
		): Promise<TestAiResult> => {
			if (counted && opened) {
				await recordUsage(db, {
					userId: admin.id,
					purpose: "assistant",
					model: opened.settings.model,
					usage: total,
				});
			}
			return {
				ok: errorCode === null,
				stage,
				errorCode,
				model: opened?.settings.model ?? null,
				usage: counted
					? { inputTokens: total.input, outputTokens: total.output }
					: null,
			};
		};
		const send = (result: TestAiResult) => {
			return reply.header("cache-control", "no-store").send(result);
		};
		if (!opened) return send(await done(null, "not-configured"));

		const { client } = opened;
		const stepRequest = (messages: StepRequest["messages"]): StepRequest => ({
			system: TEST_SYSTEM,
			messages,
			tools: [TEST_TOOL],
			maxOutputTokens: TEST_MAX_OUTPUT_TOKENS,
			signal: AbortSignal.timeout(TEST_STEP_MS),
		});
		const prompt = { role: "user" as const, text: AI_TEST_PROMPT };

		const first = await collectStep(client, stepRequest([prompt]));
		add(first.usage);
		if (first.error)
			return send(await done(first.started ? "connect" : null, first.error.code));
		if (!first.usage) return send(await done("connect", "bad-response"));
		const call = first.calls[0];
		if (!call) return send(await done("reply", "no-tool-call"));
		const word = (call.input as { word?: unknown } | null)?.word;
		if (call.name !== AI_TEST_TOOL_NAME || typeof word !== "string") {
			return send(await done("reply", "bad-tool-call"));
		}

		const second = await collectStep(
			client,
			stepRequest([
				prompt,
				{ role: "assistant", text: first.text, toolCalls: [call] },
				{ role: "tool", results: [{ id: call.id, name: call.name, text: "pong" }] },
			]),
		);
		add(second.usage);
		if (second.error) return send(await done("tool-call", second.error.code));
		if (!second.text.trim()) return send(await done("tool-call", "empty-reply"));
		return send(await done("tool-result", null));
	});

	app.get("/admin/ai/models", adminOnly, async (_request, reply) => {
		const opened = modelClientFor(await loadAiSettings(db), config);
		const out: ModelListResponse = {
			models: "unavailable" in opened ? null : await opened.client.listModels(),
		};
		return reply.header("cache-control", "no-store").send(out);
	});
}
