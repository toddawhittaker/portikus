import type { HelpPart } from "./part.js";

/** Skills, MCP servers and plugins in the chat, for both agents (SPEC.md §10.2). */
export const AGENT_TOOLS_TOPIC: HelpPart["topics"][number] = {
	id: "student-agent-tools",
	title: "Skills, MCP servers and plugins",
	body: (
		<>
			<p>
				These work in a Claude Code (GUI) chat and a Codex (GUI) chat alike. They also
				work in a terminal, where you set them up.
			</p>
			<ul>
				<li>
					<strong>Skills.</strong> Your own skills for the agent in the chat appear in
					the <code className="pk-mono-body">/</code> menu: Claude Code's as{" "}
					<code className="pk-mono-body">/name</code> and Codex's as{" "}
					<code className="pk-mono-body">$name</code>.
				</li>
				<li>
					<strong>MCP servers.</strong> An MCP server gives the agent extra tools, such
					as one for GitHub. Type <code className="pk-mono-body">/mcp</code>, or open{" "}
					<strong>Chat options</strong>, to see your servers and whether each is
					connected, starting, failed, needs you to sign in, or turned off. The list is
					read-only: add, remove and sign in to servers in a terminal, with{" "}
					<code className="pk-mono-body">claude mcp</code> or{" "}
					<code className="pk-mono-body">codex mcp</code>. A tool from an MCP server
					shows as "Used <em>tool</em> · <em>server</em>", with what it was given and
					what it returned, and asks on a card, "Allow <em>server</em> to run{" "}
					<em>tool</em>?", unless you have allowed it for this chat. If a server asks
					you for a form or a link, the chat says to use a terminal tab for it.
				</li>
				<li>
					<strong>Plugins.</strong> The skills and MCP servers of a plugin you have
					installed work in a chat. Install and manage plugins in a terminal, with{" "}
					<code className="pk-mono-body">/plugin</code> in Claude Code or{" "}
					<code className="pk-mono-body">/plugins</code> in Codex; they are greyed out
					in a chat.
				</li>
				<li>
					<strong>Project trust.</strong> A project's own MCP servers, the ones its
					files ask for, start only after you have trusted the project in a terminal.
					Open a terminal tab in the project, start the agent there, answer its trust
					question, then start a new chat.
				</li>
			</ul>
		</>
	),
};
