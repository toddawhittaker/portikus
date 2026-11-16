/**
 * A small fake of the OpenAI Chat Completions API, so the browser tests can
 * drive the built-in assistant without calling a real model (SPEC.md
 * section 20.5). It answers from scripts: the last user message picks a
 * script, and each model turn inside that exchange is the next step.
 *
 * Test controls (never part of the real API):
 *   POST /__script    add a script: { match, steps }
 *   POST /__reset     drop added scripts and recorded requests
 *   GET  /__requests  the recorded request bodies, newest last
 *
 * Request bodies are kept in memory only, so a test can check what was sent.
 * Nothing is ever written to standard output.
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

export const FAKE_MODEL_ID = "fake-model-1";
const MODELS = [FAKE_MODEL_ID, "fake-model-2"];
const FALLBACK_TEXT = "I am the fake model. Nothing in my script matched that.";

/**
 * A step is one model turn: `text`, or `toolCalls` (each `{ name, arguments }`),
 * with optional `usage` ({ prompt_tokens, completion_tokens }). Instead it may
 * set `error` to an HTTP status (401, 429 or 500), or `hang: true` to never answer.
 */
export const DEFAULT_SCRIPTS = [
	{
		match: "hello",
		steps: [{ text: "Hello! I am the fake assistant. How can I help?" }],
	},
	{
		match: "fake:read",
		steps: [
			{ toolCalls: [{ name: "users_list", arguments: {} }] },
			{ text: "I looked at the users. Everything looks normal." },
		],
	},
	{
		match: "fake:change",
		steps: [
			{
				toolCalls: [{ name: "users_disable", arguments: { userId: "fake-user" } }],
			},
			{ text: "The change was handled." },
		],
	},
	{
		match: "fake:prices",
		steps: [
			{
				toolCalls: [
					{
						name: "submit_rows",
						arguments: {
							rows: [
								{
									model: "fake-model-1",
									inputPerMillion: 1,
									outputPerMillion: 5,
								},
							],
						},
					},
				],
			},
		],
	},
	{
		match: "fake:test",
		steps: [
			{ toolCalls: [{ name: "fake_ping", arguments: { value: "ping" } }] },
			{ text: "pong" },
		],
	},
];

function messageText(message) {
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part.text === "string" ? part.text : ""))
		.join("");
}

/** The script and step index for a request, worked out from the messages alone. */
export function pickStep(scripts, messages) {
	let lastUser = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			lastUser = i;
			break;
		}
	}
	if (lastUser < 0) return undefined;
	const text = messageText(messages[lastUser]).toLowerCase();
	const script = scripts.find((s) => text.includes(s.match.toLowerCase()));
	if (!script) return undefined;
	const turnsDone = messages
		.slice(lastUser + 1)
		.filter((m) => m.role === "assistant").length;
	return script.steps[turnsDone];
}

const idCounter = { next: 1 };
const nextId = (prefix) => `${prefix}-${idCounter.next++}`;

function usageOf(step) {
	const prompt = step.usage?.prompt_tokens ?? 10;
	const completion = step.usage?.completion_tokens ?? 5;
	return {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: prompt + completion,
	};
}

/** Split text into a few pieces, so the client sees a real stream. */
function pieces(text, size = 8) {
	const out = [];
	for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
	return out;
}

function completionBody(step, model) {
	const base = {
		id: nextId("chatcmpl"),
		object: "chat.completion",
		created: 0,
		model,
		usage: usageOf(step),
	};
	if (step.toolCalls?.length) {
		return {
			...base,
			choices: [
				{
					index: 0,
					finish_reason: "tool_calls",
					message: {
						role: "assistant",
						content: null,
						tool_calls: step.toolCalls.map((call) => ({
							id: nextId("call"),
							type: "function",
							function: {
								name: call.name,
								arguments: JSON.stringify(call.arguments ?? {}),
							},
						})),
					},
				},
			],
		};
	}
	return {
		...base,
		choices: [
			{
				index: 0,
				finish_reason: "stop",
				message: { role: "assistant", content: step.text ?? FALLBACK_TEXT },
			},
		],
	};
}

function streamChunks(step, model, includeUsage) {
	const id = nextId("chatcmpl");
	const chunk = (delta, finishReason) => ({
		id,
		object: "chat.completion.chunk",
		created: 0,
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	});
	const out = [chunk({ role: "assistant", content: "" }, null)];
	if (step.toolCalls?.length) {
		step.toolCalls.forEach((call, index) => {
			const args = JSON.stringify(call.arguments ?? {});
			out.push(
				chunk(
					{
						tool_calls: [
							{
								index,
								id: nextId("call"),
								type: "function",
								function: { name: call.name, arguments: "" },
							},
						],
					},
					null,
				),
			);
			for (const piece of pieces(args, 6)) {
				out.push(
					chunk({ tool_calls: [{ index, function: { arguments: piece } }] }, null),
				);
			}
		});
		out.push(chunk({}, "tool_calls"));
	} else {
		for (const piece of pieces(step.text ?? FALLBACK_TEXT)) {
			out.push(chunk({ content: piece }, null));
		}
		out.push(chunk({}, "stop"));
	}
	if (includeUsage) {
		out.push({
			id,
			object: "chat.completion.chunk",
			created: 0,
			model,
			choices: [],
			usage: usageOf(step),
		});
	}
	return out;
}

function sendJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function sendError(res, status) {
	const type = { 401: "invalid_api_key", 429: "rate_limit_exceeded" }[status];
	sendJson(res, status, {
		error: {
			message: `fake model error ${status}`,
			type: type ?? "server_error",
			code: type ?? null,
		},
	});
}

async function readJson(req) {
	const chunks = [];
	for await (const part of req) chunks.push(part);
	const raw = Buffer.concat(chunks).toString("utf8");
	return raw ? JSON.parse(raw) : {};
}

/** Create the server without listening, so a test can pick its own port. */
export function createFakeModelServer() {
	let added = [];
	let requests = [];

	const handleChat = async (req, res) => {
		let body;
		try {
			body = await readJson(req);
		} catch {
			sendJson(res, 400, { error: { message: "invalid JSON" } });
			return;
		}
		requests.push(body);
		const messages = Array.isArray(body.messages) ? body.messages : [];
		const step = pickStep([...added].reverse().concat(DEFAULT_SCRIPTS), messages) ?? {
			text: FALLBACK_TEXT,
		};
		if (step.error) {
			sendError(res, step.error);
			return;
		}
		if (step.hang) {
			// Hold the connection open until the client gives up.
			return;
		}
		const model = typeof body.model === "string" ? body.model : FAKE_MODEL_ID;
		if (!body.stream) {
			sendJson(res, 200, completionBody(step, model));
			return;
		}
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
		});
		const includeUsage = body.stream_options?.include_usage === true;
		for (const chunk of streamChunks(step, model, includeUsage)) {
			res.write(`data: ${JSON.stringify(chunk)}\n\n`);
		}
		res.write("data: [DONE]\n\n");
		res.end();
	};

	const handleControl = async (req, res, path) => {
		if (req.method === "POST" && path === "/__script") {
			const script = await readJson(req);
			if (typeof script.match !== "string" || !Array.isArray(script.steps)) {
				sendJson(res, 400, { error: { message: "match and steps are required" } });
				return;
			}
			added.push(script);
			sendJson(res, 200, { ok: true });
		} else if (req.method === "POST" && path === "/__reset") {
			added = [];
			requests = [];
			sendJson(res, 200, { ok: true });
		} else if (req.method === "GET" && path === "/__requests") {
			sendJson(res, 200, requests);
		} else {
			sendJson(res, 404, { error: { message: "not found" } });
		}
	};

	return createServer(async (req, res) => {
		const path = new URL(req.url ?? "/", "http://fake").pathname;
		try {
			if (path.startsWith("/__")) {
				await handleControl(req, res, path);
				return;
			}
			if (!/^Bearer \S+/.test(req.headers.authorization ?? "")) {
				sendError(res, 401);
				return;
			}
			const route = path.replace(/^\/v1(?=\/)/, "");
			if (req.method === "GET" && route === "/models") {
				sendJson(res, 200, {
					object: "list",
					data: MODELS.map((id) => ({
						id,
						object: "model",
						created: 0,
						owned_by: "fake",
					})),
				});
			} else if (req.method === "POST" && route === "/chat/completions") {
				await handleChat(req, res);
			} else {
				sendJson(res, 404, { error: { message: "not found" } });
			}
		} catch {
			if (!res.headersSent) sendJson(res, 500, { error: { message: "fake failure" } });
			else res.end();
		}
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const port = Number(process.env.FAKE_MODEL_PORT ?? "7410");
	createFakeModelServer().listen(port, "127.0.0.1");
}
