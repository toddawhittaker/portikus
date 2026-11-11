import type { HelpPart } from "./part.js";

/** The student topic on coding agent status, alerts and usage (SPEC.md 8.5, 10.8, 25.10). */
export const AGENT_STATUS_TOPIC: HelpPart["topics"][number] = {
	id: "student-agent-status",
	title: "Coding agent status, alerts and usage",
	body: (
		<>
			<p>
				A terminal running Claude Code or Codex shows what the agent is doing, in its
				tab and in the project list. The mark has a shape as well as a color, and the
				tab's name says it too.
			</p>
			<ul>
				<li>
					An open ring means the agent is <strong>working</strong>.
				</li>
				<li>
					A triangle means it <strong>needs your input</strong>, such as a permission.
				</li>
				<li>
					A check means it has <strong>finished</strong>. A bold tab name means you have
					not looked at it yet. The marks forget this when you reload the page.
				</li>
				<li>
					A project in the list shows the most urgent state of its terminals, so you can
					see an agent in another project that is waiting for you.
				</li>
				<li>
					Under each project, the project list also shows each agent tab that has
					reported, with what it is doing and for how long, such as "Working 4m". Under
					an agent, its subagents are listed with their description, type and state.
					Select a row to go to its tab. In a chat, selecting a subagent opens a
					read-only view of its conversation. Use the arrow button beside a project to
					hide or show its agents. Rows appear after the agent's first report, and Codex
					shows no subagents.
				</li>
				<li>
					If you stop Claude Code with Esc, its tab keeps showing "working" until you
					type your next prompt.
				</li>
			</ul>
			<h4>Alerts</h4>
			<p>
				When an agent finishes or needs input in a tab you are not looking at, a message
				pops up. For another project it has <strong>Open project</strong>. These
				messages are not kept in <strong>Notifications</strong>.{" "}
				<kbd className="pk-mono-body">F8</kbd> moves to the newest one, even from inside
				a terminal; press <kbd className="pk-mono-body">Tab</kbd> to reach its buttons.
			</p>
			<h4>Desktop notifications</h4>
			<p>
				Portikus can also send a notification from your computer when the page is hidden
				or not focused. It says only which agent and what it needs, for example "Claude
				Code needs your input", never a project or terminal name. Choose{" "}
				<strong>Ask me</strong>, <strong>On</strong> or <strong>Off</strong> under{" "}
				<strong>Desktop notifications</strong> in <strong>Settings</strong> then{" "}
				<strong>Preferences</strong>. The first agent message after you open the page
				also offers to turn them on.
			</p>
			<ul>
				<li>
					Choosing <strong>On</strong> saves your choice but does not ask your browser.
					Press <strong>Allow in this browser</strong> to do that.
				</li>
				<li>
					If the browser blocks them, allow notifications for this site in the browser's
					site settings.
				</li>
			</ul>
			<h4>Usage</h4>
			<p>
				The status bar shows how much of each agent's seven-day plan limit you have used
				and when it resets, for example "Claude 91% resets Thu 7:21 PM". Choose it for
				the details. A message warns you once when a limit passes 85 percent. If you
				sign in to an agent with an API key, which has no plan limit, the bar shows your
				tokens and cost for today instead. Today is counted by the clock in UTC, and the
				numbers update about every five minutes. A course that hides Claude Code and
				Codex hides this too.
			</p>
		</>
	),
};
