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
				and choose the model, version, effort and permission mode beside the message
				box.
			</p>
			<ul>
				<li>
					The message box understands Markdown as you type: two stars make bold, one
					star italic, three stars both, two tildes strike through, and backticks make
					code. At the start of a line, three backticks start a code block, a dash or
					"1." a list, "[ ]" or "[x]" a task, "&gt;" a quote, one to three "#" a
					heading, and three dashes a separator line. Type or paste an http or https
					address, or write [text](address), to make a link. In a list, Tab indents an
					item and Shift+Tab moves a nested item back out. Enter sends and Shift+Enter
					adds a line. In a code block Enter adds a line, and Ctrl+Enter (Cmd+Enter on a
					Mac) sends.
				</li>
				<li>
					Type <code className="pk-mono-body">/</code> at the start of a message to see
					Claude's commands, or <code className="pk-mono-body">@</code> anywhere to pick
					a project file. Use the arrow keys to move, Enter to insert (Tab does too,
					after an arrow key), and Escape to close the list. Commands that only work in
					the terminal are greyed out; <code className="pk-mono-body">/model</code> and{" "}
					<code className="pk-mono-body">/effort</code> open the pickers below the box
					instead. The <code className="pk-mono-body">@</code> list shows files only,
					not folders, and skips files your project's{" "}
					<code className="pk-mono-body">.gitignore</code> leaves out.{" "}
					<code className="pk-mono-body">/clear</code> starts a fresh conversation in
					the same tab.
				</li>
				<li>
					Start a message with <code className="pk-mono-body">!</code> to run it as a
					shell command in the project folder, as in the terminal. The box shows a Shell
					label while you type it. Enter runs it, the command and its output appear in
					the conversation, and Claude sees them with your next message. A command stops
					after two minutes, and only the first 64 KiB of its output is kept. It cannot
					ask you questions, so use a terminal tab for those. You cannot run one while
					Claude is working. Stop, or Esc, ends a command that is still running.
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
					<strong>Deny</strong> and <strong>No, keep planning</strong> open a line,
					"Tell Claude what to do instead". Type a reason and press Enter to send it to
					Claude, or press Enter with nothing typed to deny without one. Escape goes
					back to the buttons.
				</li>
				<li>
					When Claude offers a plan, choose <strong>Yes, and accept edits</strong> to
					let it change files without asking, <strong>Yes, and ask before edits</strong>{" "}
					to approve each change, or <strong>No, keep planning</strong>. Your choice
					sets the Permissions picker.
				</li>
				<li>
					Code in replies has a language label and syntax colours. A very long block, or
					one in a language Portikus does not colour, shows as plain text.
				</li>
				<li>
					A speaker button under each of Claude's replies reads it aloud; press it again
					to stop. Turn on <strong>Read replies aloud</strong> in the{" "}
					<strong>Chat options</strong> panel to hear the last reply of each turn when
					Claude finishes. Escape, sending a message or leaving the tab stops the
					speech. Code blocks are not read; you hear "code block" instead. Your browser
					makes the voice, and Portikus never receives or keeps the text. Portikus picks
					a voice on your device when there is one. If your browser has only an online
					voice for your language, such as Chrome's Google voices, the text of the reply
					is sent to the browser's maker to be spoken.
				</li>
				<li>
					Under the pickers, Portikus always shows how full Claude's memory of this chat
					is, as a meter with figures such as "34.2k / 1M", and how long until the
					prompt cache goes cold. The meter changes look as it fills: at 25, 50, 75 and
					90 percent. From 75 percent it adds an alert and "nearly full". While the
					cache is warm, your next message is faster and uses less of your limit. In the
					last minute it says "soon", and when it says "Cache cold" the next message
					re-reads the whole chat. When the memory is high, type{" "}
					<code className="pk-mono-body">/compact</code>. Your screen reader hears only
					when the cache goes cold and when the memory reaches 75 and then 90 percent.
				</li>
				<li>
					When Claude edits files, a line under its reply says how many changed. Open it
					to see each file; choose one to open it, or its changes in a Git project.
				</li>
				<li>
					Pasting more than 40 lines, such as an error log, attaches it as a text file
					instead of filling the message box. To put it in the box instead, paste it
					again straight away. You can also choose{" "}
					<strong>Insert pasted text inline</strong> on the file's chip.
				</li>
				<li>
					Sign in to Claude in the workspace, as you would in a terminal. Portikus never
					sees your Claude sign-in. If you are not signed in, the chat says so.
				</li>
				<li>
					A chat tab keeps running when you close the browser. When the workspace has
					stopped and started again, the ended tab offers <strong>New chat</strong>,{" "}
					<strong>Resume chat</strong> and <strong>New terminal here</strong>. Choose{" "}
					<strong>Resume chat</strong> to carry on the same conversation; it reloads the
					earlier chat and uses more of your plan. <strong>New chat</strong> starts
					fresh. A reply that was still being written when the workspace stopped is
					lost.
				</li>
				<li>
					The Permissions picker has five modes. <strong>Ask</strong> asks before Claude
					edits files or runs commands. <strong>Accept edits</strong> lets it edit files
					on its own but asks before commands. <strong>Plan</strong> lets it read and
					plan but change nothing; when the plan is ready, it asks you to approve it.{" "}
					<strong>Auto</strong> runs what Claude judges safe and asks about the rest.{" "}
					<strong>Bypass permissions</strong> is described below.
				</li>
				<li>
					<strong>Bypass permissions</strong> lets Claude run commands and change files
					without asking. A warning shows while it is on.
				</li>
				<li>
					The <strong>Model</strong> picker lists the models Claude Code offers. Under
					it, <strong>Version</strong> is Latest by default, which follows the newest
					version of that model; choose a version to stay on it. A new chat starts with
					the model, version, effort and permissions you last chose in that project. The
					very first chat in a project starts on Opus, Medium effort and Auto. Bypass
					permissions is never carried over: a new chat starts in Auto instead. If a
					model has no Auto mode, a new chat starts in Ask, and switching to such a
					model while in Auto changes Permissions to Ask.
				</li>
				<li>
					Each chat has a title, shown under its name in the project list and on its
					tab. It starts as Claude Code's own summary of the conversation. To give it
					your own, choose the pencil beside the chat in the project list, type a name
					and press Enter (Escape cancels), or type{" "}
					<code className="pk-mono-body">/rename</code> in the chat. Titles are not kept
					by Portikus; they live in Claude Code's own record in your workspace. A Claude
					Code (TUI) terminal keeps its tab name.
				</li>
				<li>
					When Claude starts a subagent, a row for it appears under the chat in the
					project list. Choose the row to watch what the subagent is doing in a panel
					inside the chat. The view is read-only: to pass it a message, ask Claude in
					the main chat. A subagent Claude started in the background shows as "Started
					in the background", with its state, on its card in the conversation.
				</li>
				<li>
					A chat zooms on its own, from 50% to 300%: hold{" "}
					<kbd className="pk-mono-body">Ctrl</kbd> (
					<kbd className="pk-mono-body">Cmd</kbd> on a Mac) and turn the wheel over it,
					pinch on a trackpad, press <kbd className="pk-mono-body">Ctrl+Shift+=</kbd>,{" "}
					<kbd className="pk-mono-body">Ctrl+Shift+-</kbd> or{" "}
					<kbd className="pk-mono-body">Ctrl+0</kbd>, or use the zoom buttons in the
					chat's title bar.
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
