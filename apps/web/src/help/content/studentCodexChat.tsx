import type { HelpPart } from "./part.js";

/** The Codex chat tab and the terminal Codex (SPEC.md §10.2, §10.8). */
export const CODEX_CHAT_TOPIC: HelpPart["topics"][number] = {
	id: "student-codex-chat",
	title: "Codex (GUI) and Codex (TUI)",
	body: (
		<>
			<p>
				Codex opens two ways from <strong>New tab</strong>. <strong>Codex (TUI)</strong>{" "}
				is Codex in a terminal. <strong>Codex (GUI)</strong> is a chat tab that works
				like the Claude Code chat tab: formatted replies, its work folded into a "Worked
				for" row, cards for permissions and questions, images, and the message box,
				menus, <code className="pk-mono-body">!</code> shell commands, read aloud and
				zoom described in the Claude Code topic above. This topic covers what is
				different for Codex.
			</p>
			<ul>
				<li>
					Sign in to Codex in the workspace, as you would in a terminal. Portikus never
					sees your Codex sign-in. If you are not signed in, the chat says so; sign in
					in a Codex (TUI) tab, or run{" "}
					<code className="pk-mono-body">codex login --device-auth</code> in a terminal.
				</li>
				<li>
					Do not run a Codex (GUI) tab and a Codex (TUI) terminal on the same Codex
					session at once.
				</li>
				<li>
					<strong>Chat options</strong> shows Agent, Model, Effort and Permissions.
					There is no Version, because Codex's models are not pinned to versions. Each
					model lists its own efforts, and the model's usual one is marked Default. A
					new Codex chat starts with the model, effort and permissions you last chose in
					that project, or with your own Codex settings the first time.
				</li>
				<li>
					The Permissions picker has five modes. <strong>Ask</strong> asks before Codex
					runs any command that could change something. <strong>Read only</strong> lets
					it read and answer, and asks before it changes anything. <strong>Plan</strong>{" "}
					lets it look around and write a plan before it changes anything.{" "}
					<strong>Auto</strong> lets it work in the project on its own, and asks before
					it goes outside it. <strong>Full access</strong> runs anything without asking
					and without a sandbox; a warning shows while it is on, and a new chat never
					starts in it.
				</li>
				<li>
					When Codex offers a plan, choose <strong>Yes, in Auto</strong> to let it carry
					the plan out, <strong>Yes, and ask first</strong> to approve each change, or{" "}
					<strong>No, keep planning</strong>. The plan stays in the conversation, and a
					line under it says what you chose.
				</li>
				<li>
					A permission card offers <strong>Allow once</strong>, <strong>Deny</strong>{" "}
					and, when Codex offers it, <strong>Allow for this chat</strong>. There is no
					"Always allow", because it would change Codex's own settings for good. Codex
					remembers "Allow for this chat" itself, so the list of rules under the pickers
					does not show it and you cannot revoke it there. Starting a new chat clears
					it.
				</li>
				<li>
					When Codex asks a question, you answer on a card. A question may have options,
					or a single box for typing. If it asks for a secret, such as a token, the box
					hides what you type, and the answer is never shown in the conversation.
				</li>
				<li>
					Type <code className="pk-mono-body">/</code> to see Codex's commands.{" "}
					<code className="pk-mono-body">/model</code>,{" "}
					<code className="pk-mono-body">/effort</code> and{" "}
					<code className="pk-mono-body">/permissions</code> open the pickers;{" "}
					<code className="pk-mono-body">/plan</code>,{" "}
					<code className="pk-mono-body">/compact</code>,{" "}
					<code className="pk-mono-body">/new</code>,{" "}
					<code className="pk-mono-body">/clear</code>,{" "}
					<code className="pk-mono-body">/rename</code>,{" "}
					<code className="pk-mono-body">/review</code> and{" "}
					<code className="pk-mono-body">/mcp</code> run in the chat. Commands that need
					the terminal, such as <code className="pk-mono-body">/resume</code>,{" "}
					<code className="pk-mono-body">/fork</code>,{" "}
					<code className="pk-mono-body">/status</code>,{" "}
					<code className="pk-mono-body">/diff</code>,{" "}
					<code className="pk-mono-body">/init</code>,{" "}
					<code className="pk-mono-body">/plugins</code> and{" "}
					<code className="pk-mono-body">/logout</code>, are greyed out.
				</li>
				<li>
					Your Codex skills start with a dollar sign. Type{" "}
					<code className="pk-mono-body">$</code> at the start of a message to see only
					your skills, or find them in the <code className="pk-mono-body">/</code> list
					as <code className="pk-mono-body">$name</code>. When Codex uses one, the
					conversation says "Used skill" and its name. Claude Code's skills start with{" "}
					<code className="pk-mono-body">/</code> instead.
				</li>
				<li>
					Codex shows what it does in the same rows as Claude Code. A command reads as
					"Read a.ts", "Listed files in src" or "Searched for x" when Codex says what it
					is doing, and a file change shows a diff for each file. When Codex starts a
					subagent, a row for it appears under the chat in the project list, and its
					card in the conversation opens a read-only view of what the subagent is doing.
					Codex gives a subagent no description, so its row shows only its type. A Codex
					(TUI) terminal shows its subagents in the project list too.
				</li>
				<li>
					Under the pickers, Portikus shows how full Codex's memory of this chat is, as
					a meter, and warns as it fills; type{" "}
					<code className="pk-mono-body">/compact</code> when it is high. Codex gives no
					prompt cache timing, so there is no countdown, only the tokens used.
				</li>
				<li>
					You can switch agents in the middle of a chat. Open{" "}
					<strong>Chat options</strong> and choose the other agent in the{" "}
					<strong>Agent</strong> menu. Portikus warns you first: the new agent starts
					fresh with this conversation as its context, and the prompt cache is lost, so
					the next message may use more of your limit. The new agent gets your earlier
					messages and its own replies in the same chat, with each tool call reduced to
					a short summary. If the whole conversation would not fit the new agent's
					memory, the oldest turns are left out, and the warning says so. A line in the
					conversation marks where the agent changed. A chat with nothing in it switches
					with no warning.
				</li>
			</ul>
			<h4>What Codex cannot do here</h4>
			<ul>
				<li>
					In a Codex (TUI) terminal, when Codex asks you a question, the tab shows
					"needs your input", but there is no question card in the browser. Answer in
					the terminal. The Codex (GUI) chat does have the card.
				</li>
				<li>
					"Allow for this chat" is kept by Codex and cannot be revoked from Portikus's
					list; a new chat clears it.
				</li>
				<li>The memory meter counts tokens only, with no cache countdown.</li>
				<li>
					Servers and plugins cannot be added, signed in to or removed from a chat, and
					a project's own MCP servers wait for trust in a terminal. See{" "}
					<a href="#student-agent-tools">Skills, MCP servers and plugins</a>.
				</li>
			</ul>
		</>
	),
};
