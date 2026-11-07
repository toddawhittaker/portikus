// Records real Agent SDK frames for the chat adapter's tests.
// Usage: node scripts/record-chat-frames.mjs <empty folder> <out.jsonl>
// The folder must hold red.png. Uses the local `claude` with Haiku.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";

const [dir, out] = process.argv.slice(2);
const sessionId = randomUUID();
const frames = [];
const prompts = [
	"Run the shell command `echo hello-portikus` with the Bash tool, then use the Read tool on red.png, then say done in one word.",
	"Use the AskUserQuestion tool to ask me one single-select question, header 'Colour', with two options 'Red' and 'Blue'. Then reply with exactly what I picked and any notes I gave.",
];

let wake;
async function* input() {
	for (const text of prompts) {
		yield {
			type: "user",
			message: { role: "user", content: text },
			parent_tool_use_id: null,
		};
		await new Promise((resolve) => {
			wake = resolve;
		});
	}
}

const q = query({
	prompt: input(),
	options: {
		cwd: dir,
		sessionId,
		model: "haiku",
		includePartialMessages: true,
		settingSources: [],
		pathToClaudeCodeExecutable:
			process.env.CLAUDE_BIN ?? `${process.env.HOME}/.local/bin/claude`,
		canUseTool: async (toolName, toolInput, options) => {
			frames.push({
				canUseTool: {
					toolName,
					input: toolInput,
					suggestions: options.suggestions,
					title: options.title,
					toolUseID: options.toolUseID,
				},
			});
			if (toolName === "AskUserQuestion") {
				const question = toolInput.questions[0].question;
				return {
					behavior: "allow",
					updatedInput: {
						...toolInput,
						answers: { [question]: "Blue" },
						annotations: { [question]: { notes: "navy please" } },
					},
				};
			}
			return { behavior: "allow", updatedInput: toolInput };
		},
	},
});

for await (const message of q) {
	frames.push(message);
	if (message.type === "result") {
		if (!wake) break;
		const next = wake;
		wake = undefined;
		next();
		if (frames.filter((f) => f.type === "result").length === prompts.length) break;
	}
}
q.close();
// Live ids and account times are swapped for numbered fakes, so the
// fixture holds nothing from a real session.
const fakes = new Map();
function fake(kind, value, make) {
	const key = `${kind}:${value}`;
	if (!fakes.has(key)) {
		const n = [...fakes.keys()].filter((k) => k.startsWith(`${kind}:`)).length + 1;
		fakes.set(key, make(String(n).padStart(4, "0")));
	}
	return fakes.get(key);
}
const id = (value) =>
	value.startsWith("toolu_")
		? fake("tool", value, (n) => `toolu_fixture_${n}`)
		: value.startsWith("msg_")
			? fake("msg", value, (n) => `msg_00000000${n}`)
			: value;
function scrub(value, key) {
	if (Array.isArray(value)) return value.map((v) => scrub(v, key));
	if (typeof value === "string") {
		if (key === "session_id" || key === "uuid") {
			return fake(
				key,
				value,
				(n) => `00000000-0000-4000-8000-0000000${n.padStart(5, "0")}`,
			);
		}
		if (key === "request_id") return fake(key, value, (n) => `req_fixture_${n}`);
		if (
			key === "api_message_id" ||
			key === "id" ||
			key === "tool_use_id" ||
			key === "toolUseID"
		)
			return id(value);
		if (key === "timestamp") return "2026-01-01T00:00:00.000Z";
		return value;
	}
	if (
		typeof value === "number" &&
		(key === "resetsAt" || key === "credential_expires_at")
	) {
		return 1800000000;
	}
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([k, v]) => [id(k), scrub(v, k)]),
	);
}
writeFileSync(out, `${frames.map((f) => JSON.stringify(scrub(f))).join("\n")}\n`);
console.log(sessionId);
