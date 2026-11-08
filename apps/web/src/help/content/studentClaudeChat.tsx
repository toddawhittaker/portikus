import type { HelpPart } from "./part.js";

/** The chat tab and the terminal Claude Code (SPEC.md §10.8). */
export const CLAUDE_CHAT_TOPIC: HelpPart["topics"][number] = {
	id: "student-claude-chat",
	title: "Claude Code (GUI) and Claude Code (TUI)",
	body: (
		<>
			<p>
				Claude Code opens two ways from <strong>New tab</strong>.{" "}
				<strong>Claude Code (TUI)</strong> is Claude Code in a terminal.{" "}
				<strong>Claude Code (GUI)</strong> is a chat tab: replies appear as formatted
				text, its work is folded into a "Worked for" row, and when it needs a permission
				or asks a question you answer on a card. You can paste, drop or attach images,
				and choose the model, effort and permission mode beside the message box.
			</p>
			<ul>
				<li>
					The message box understands Markdown as you type: two stars make bold, one
					star italic, three stars both, two tildes strike through, and backticks make
					code. At the start of a line, three backticks start a code block, a dash or
					"1." a list, "[ ]" or "[x]" a task, "&gt;" a quote, one to three "#" a
					heading, and three dashes a separator line. Type or paste an http or https
					address, or write [text](address), to make a link. In a list, Tab indents an
					item and Shift+Tab moves it back out. Enter sends and Shift+Enter adds a line.
					In a code block Enter adds a line, and Ctrl+Enter (Cmd+Enter on a Mac) sends.
				</li>
				<li>
					While Claude works you can still send a message. Claude reads it at its next
					step without stopping, and the message is marked "Sent while Claude was
					working". Some models treat a message sent this way with caution, because they
					can read it as part of a tool's output. If Claude does not act on it, stop
					Claude, then send it again; that always works. Esc in the message box stops
					Claude. Up in an empty box brings back your last message.
				</li>
				<li>
					On a permission card, press 1, 2 or 3 to choose an option. The keys work only
					on the card, never while you type in the message box.
				</li>
				<li>
					Pasting more than 40 lines, such as an error log, attaches it as a text file
					instead of filling the message box. To put it in the box instead, paste it
					again straight away, within a second.
				</li>
				<li>
					Sign in to Claude in the workspace, as you would in a terminal. Portikus never
					sees your Claude sign-in. If you are not signed in, the chat says so.
				</li>
				<li>
					A chat tab keeps running when you close the browser. When the workspace has
					stopped and started again, choose <strong>Resume chat</strong> on the ended
					tab to carry on the same conversation. A reply that was still being written
					when the workspace stopped is lost.
				</li>
				<li>
					<strong>Bypass permissions</strong> lets Claude run commands and change files
					without asking. A warning shows while it is on.
				</li>
				<li>
					A new chat starts with the model, effort and permissions you last chose in
					that project. Bypass permissions is never carried over: a new chat starts in
					Auto instead.
				</li>
				<li>
					When Permissions shows Ask but you have chosen "Always allow" for something in
					this chat, a line under the pickers says so. The list "Allowed without asking
					in this session" shows each rule and lets you revoke it.
				</li>
				<li>
					Do not run a GUI tab and a TUI terminal on the same Claude session at once.
					After a chat tab is closed, running{" "}
					<code className="pk-mono-body">claude --resume</code> in a terminal continues
					it.
				</li>
			</ul>
		</>
	),
};
