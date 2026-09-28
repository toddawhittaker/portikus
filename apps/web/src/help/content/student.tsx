import type { HelpPart } from "./part.js";

/**
 * Getting started, for everyone. Add a topic by adding an entry; its id is
 * "student-<topic>" and becomes the anchor, such as /help#student-projects.
 */
export const STUDENT_HELP: HelpPart = {
	id: "student",
	title: "Using your workspace",
	topics: [
		{
			id: "student-workspace",
			title: "Your workspace",
			body: (
				<p>
					Portikus gives you one workspace: a Linux machine of your own with a shell,
					Git, Docker, Claude Code and Codex. It keeps running for a short while after
					you close its last browser tab, then stops. Opening Portikus starts it again,
					and your files are where you left them.
				</p>
			),
		},
		{
			id: "student-projects",
			title: "Projects",
			body: (
				<p>
					A project is a folder in <code className="pk-mono-body">~/projects</code>.
					Create one, or clone a repository, from the project list on the left. Renaming
					a project renames its folder. Portikus keeps recovery points of each project;
					choose <strong>Recovery points…</strong> in a project's menu to see them or go
					back to one.
				</p>
			),
		},
		{
			id: "student-tabs",
			title: "Terminals, agents and previews",
			body: (
				<>
					<p>
						The <strong>New tab</strong> button beside the tabs opens a terminal, Claude
						Code or Codex in the project's folder, or a preview of a web server you run
						there. A preview can always open in a new browser tab.
					</p>
					<p>
						A terminal takes every key you press. Press{" "}
						<kbd className="pk-mono-body">Alt+Shift+Q</kbd> to move focus out of it to
						the tabs.
					</p>
				</>
			),
		},
	],
};
