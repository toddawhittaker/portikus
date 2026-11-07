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
writeFileSync(out, `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`);
console.log(sessionId);
