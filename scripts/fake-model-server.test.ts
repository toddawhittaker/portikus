import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
// @ts-expect-error The fake server is a plain .mjs script with no type declarations.
import { createFakeModelServer } from "../e2e/fake-model-server.mjs";

type Message = { role: string; content?: string | null; [key: string]: unknown };
type Chunk = {
	choices: {
		delta: {
			content?: string;
			tool_calls?: {
				index: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}[];
		};
		finish_reason: string | null;
	}[];
	usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

let server: Server;
let base: string;

beforeAll(async () => {
	server = createFakeModelServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
	await fetch(`${base}/__reset`, { method: "POST" });
});

const AUTH = { authorization: "Bearer test-key", "content-type": "application/json" };

function chat(
	messages: Message[],
	extra: Record<string, unknown> = {},
	signal?: AbortSignal,
) {
	return fetch(`${base}/v1/chat/completions`, {
		method: "POST",
		headers: AUTH,
		body: JSON.stringify({ model: "fake-model-1", messages, ...extra }),
		signal,
	});
}

async function streamed(messages: Message[], includeUsage = true) {
	const response = await chat(messages, {
		stream: true,
		...(includeUsage ? { stream_options: { include_usage: true } } : {}),
	});
	const lines = (await response.text()).split("\n\n").filter(Boolean);
	const done = lines.pop();
	const chunks = lines.map((line) => JSON.parse(line.replace(/^data: /, "")) as Chunk);
	return { response, chunks, done };
}

function addScript(script: unknown) {
	return fetch(`${base}/__script`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(script),
	});
}

/** Join the streamed tool-call pieces back into whole calls. */
function toolCalls(chunks: Chunk[]) {
	const calls: { id?: string; name?: string; arguments: string }[] = [];
	for (const chunk of chunks) {
		for (const call of chunk.choices[0]?.delta.tool_calls ?? []) {
			calls[call.index] ??= { arguments: "" };
			const entry = calls[call.index] as {
				id?: string;
				name?: string;
				arguments: string;
			};
			entry.id ??= call.id;
			entry.name ??= call.function?.name;
			entry.arguments += call.function?.arguments ?? "";
		}
	}
	return calls;
}

describe("models", () => {
	test.each(["/v1/models", "/models"])("%s lists fake-model-1", async (path) => {
		const response = await fetch(`${base}${path}`, {
			headers: { authorization: "Bearer k" },
		});
		const body = (await response.json()) as { data: { id: string }[] };
		expect(body.data.map((m) => m.id)).toContain("fake-model-1");
	});
});

describe("authorization", () => {
	test("refuses a missing or malformed Authorization header with 401", async () => {
		for (const headers of [
			{},
			{ authorization: "Basic abc" },
			{ authorization: "Bearer " },
		]) {
			const response = await fetch(`${base}/v1/models`, { headers });
			expect(response.status).toBe(401);
		}
	});

	test("refuses chat without a bearer token", async () => {
		const response = await fetch(`${base}/chat/completions`, {
			method: "POST",
			body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
		});
		expect(response.status).toBe(401);
	});
});

describe("streaming text", () => {
	test("sends content pieces, a stop, a usage chunk and [DONE]", async () => {
		const { response, chunks, done } = await streamed([
			{ role: "user", content: "Hello there" },
		]);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		const text = chunks.map((c) => c.choices[0]?.delta.content ?? "").join("");
		expect(text).toContain("fake assistant");
		expect(chunks.filter((c) => c.choices[0]?.delta.content).length).toBeGreaterThan(1);
		expect(chunks.some((c) => c.choices[0]?.finish_reason === "stop")).toBe(true);
		expect(chunks.at(-1)?.usage?.total_tokens).toBe(15);
		expect(done).toBe("data: [DONE]");
	});

	test("leaves out the usage chunk unless include_usage is set", async () => {
		const { chunks } = await streamed([{ role: "user", content: "hello" }], false);
		expect(chunks.some((c) => c.usage)).toBe(false);
	});

	test("answers an unmatched message with the short default text", async () => {
		const { chunks } = await streamed([{ role: "user", content: "zzz" }]);
		const text = chunks.map((c) => c.choices[0]?.delta.content ?? "").join("");
		expect(text).toContain("Nothing in my script matched");
	});

	test("reads a message whose content is a list of text parts", async () => {
		const { chunks } = await streamed([
			{ role: "user", content: [{ type: "text", text: "HELLO" }] as never },
		]);
		const text = chunks.map((c) => c.choices[0]?.delta.content ?? "").join("");
		expect(text).toContain("fake assistant");
	});
});

describe("streaming tool calls", () => {
	test("splits arguments over several chunks that rebuild the JSON", async () => {
		const { chunks } = await streamed([{ role: "user", content: "fake:prices" }]);
		const [call] = toolCalls(chunks);
		expect(call?.name).toBe("submit_rows");
		expect(call?.id).toBeTruthy();
		const pieceCount = chunks.filter(
			(c) => c.choices[0]?.delta.tool_calls?.[0]?.function?.arguments,
		).length;
		expect(pieceCount).toBeGreaterThan(1);
		expect(JSON.parse(call?.arguments ?? "")).toMatchObject({
			rows: [{ model: "fake-model-1" }],
		});
		expect(chunks.some((c) => c.choices[0]?.finish_reason === "tool_calls")).toBe(true);
	});

	test("sends several calls in one turn, each with its own index", async () => {
		await addScript({
			match: "two things",
			steps: [
				{
					toolCalls: [
						{ name: "a", arguments: { n: 1 } },
						{ name: "b", arguments: { n: 2 } },
					],
				},
			],
		});
		const { chunks } = await streamed([{ role: "user", content: "two things" }]);
		const calls = toolCalls(chunks);
		expect(calls.map((c) => c.name)).toEqual(["a", "b"]);
		expect(calls.map((c) => JSON.parse(c.arguments))).toEqual([{ n: 1 }, { n: 2 }]);
		expect(calls[0]?.id).not.toBe(calls[1]?.id);
	});
});

describe("scripts", () => {
	test("continues the script after a tool result", async () => {
		const user: Message = { role: "user", content: "fake:test" };
		const first = await streamed([user]);
		const [call] = toolCalls(first.chunks);
		const assistant: Message = {
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: call?.id,
					type: "function",
					function: { name: call?.name, arguments: call?.arguments },
				},
			],
		};
		const second = await streamed([
			user,
			assistant,
			{ role: "tool", tool_call_id: call?.id, content: "ok" },
		]);
		const text = second.chunks.map((c) => c.choices[0]?.delta.content ?? "").join("");
		expect(text).toBe("pong");
	});

	test("a script added by the test wins over a built-in one and takes custom usage", async () => {
		await addScript({
			match: "hello",
			steps: [{ text: "custom", usage: { prompt_tokens: 100, completion_tokens: 7 } }],
		});
		const { chunks } = await streamed([{ role: "user", content: "hello" }]);
		expect(chunks.map((c) => c.choices[0]?.delta.content ?? "").join("")).toBe(
			"custom",
		);
		expect(chunks.at(-1)?.usage).toEqual({
			prompt_tokens: 100,
			completion_tokens: 7,
			total_tokens: 107,
		});
	});

	test("rejects a script without match and steps", async () => {
		expect((await addScript({ match: "x" })).status).toBe(400);
	});

	test("reset removes added scripts", async () => {
		await addScript({ match: "hello", steps: [{ text: "custom" }] });
		await fetch(`${base}/__reset`, { method: "POST" });
		const { chunks } = await streamed([{ role: "user", content: "hello" }]);
		expect(chunks.map((c) => c.choices[0]?.delta.content ?? "").join("")).toContain(
			"fake assistant",
		);
	});
});

describe("not streaming", () => {
	test("answers a plain completion with usage", async () => {
		const response = await chat([{ role: "user", content: "hello" }]);
		const body = (await response.json()) as {
			choices: { message: { content: string }; finish_reason: string }[];
			usage: { total_tokens: number };
		};
		expect(body.choices[0]?.finish_reason).toBe("stop");
		expect(body.choices[0]?.message.content).toContain("fake assistant");
		expect(body.usage.total_tokens).toBe(15);
	});

	test("answers a tool call with the arguments as one JSON string", async () => {
		const response = await chat([{ role: "user", content: "fake:change" }]);
		const body = (await response.json()) as {
			choices: {
				finish_reason: string;
				message: { tool_calls: { function: { name: string; arguments: string } }[] };
			}[];
		};
		const call = body.choices[0]?.message.tool_calls[0]?.function;
		expect(body.choices[0]?.finish_reason).toBe("tool_calls");
		expect(call?.name).toBe("users_disable");
		expect(JSON.parse(call?.arguments ?? "")).toEqual({ userId: "fake-user" });
	});
});

describe("errors on demand", () => {
	test.each([401, 429, 500])("a step can answer HTTP %i", async (status) => {
		await addScript({ match: "boom", steps: [{ error: status }] });
		const response = await chat([{ role: "user", content: "boom" }], { stream: true });
		expect(response.status).toBe(status);
		const body = (await response.json()) as { error: { message: string } };
		expect(body.error.message).toContain(String(status));
	});

	test("a step can hang until the client aborts", async () => {
		await addScript({ match: "stall", steps: [{ hang: true }] });
		const controller = new AbortController();
		const pending = chat([{ role: "user", content: "stall" }], {}, controller.signal);
		const outcome = await Promise.race([
			pending.then(() => "answered"),
			new Promise((resolve) => setTimeout(() => resolve("waiting"), 200)),
		]);
		expect(outcome).toBe("waiting");
		controller.abort();
		await expect(pending).rejects.toThrow();
	});
});

describe("recorded requests", () => {
	test("returns the bodies sent, and reset clears them", async () => {
		await chat([{ role: "user", content: "hello" }], { stream: false });
		const recorded = (await (await fetch(`${base}/__requests`)).json()) as {
			messages: Message[];
		}[];
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.messages[0]?.content).toBe("hello");
		await fetch(`${base}/__reset`, { method: "POST" });
		expect(await (await fetch(`${base}/__requests`)).json()).toEqual([]);
	});

	test("answers 400 to a body that is not JSON", async () => {
		const response = await fetch(`${base}/v1/chat/completions`, {
			method: "POST",
			headers: AUTH,
			body: "{not json",
		});
		expect(response.status).toBe(400);
	});

	test("answers 404 to an unknown path", async () => {
		const response = await fetch(`${base}/v1/nope`, { headers: AUTH });
		expect(response.status).toBe(404);
		expect((await fetch(`${base}/__nope`)).status).toBe(404);
	});
});
