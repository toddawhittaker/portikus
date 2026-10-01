import type { HelpPart } from "./part.js";

/** The keys that are hard to discover (moved here from Settings, Epic 25 S4). */
const KEYS: readonly { keys: string; what: string }[] = [
	{
		keys: "Alt+Shift+Q",
		what: "Leave a terminal. While a terminal has the keyboard, Tab goes to the shell. Each terminal's three-dots menu also has Leave terminal.",
	},
	{
		keys: "Ctrl+M",
		what: "In the editor, switch whether Tab types a tab or moves focus out of the editor.",
	},
	{ keys: "Alt+F1", what: "In the editor, open the editor's own accessibility help." },
	{
		keys: "Alt+Shift+Left Arrow, Alt+Shift+Right Arrow",
		what: "Move the focused tab left or right. Delete closes it.",
	},
	{
		keys: "Shift+F10",
		what: "Open the menu of the focused row in the file tree. The Menu key does the same.",
	},
	{
		keys: "F8",
		what: "Move to notifications. Inside the editor F8 goes to the next problem instead, so leave the editor first.",
	},
];

/** A minimal GitHub Actions workflow that builds and pushes to ghcr.io. */
const IMAGE_WORKFLOW = `name: image
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/\${{ github.repository }}:latest`;

/**
 * For everyone who has a workspace. Each topic's id is "student-<topic>" and
 * becomes its anchor; Settings links to /help#student-keyboard, so keep that one.
 */
export const STUDENT_HELP: HelpPart = {
	id: "student",
	title: "Using your workspace",
	topics: [
		{
			id: "student-getting-started",
			title: "Getting started",
			body: (
				<>
					<p>
						Portikus gives you a workspace of your own: a Linux machine with a shell,
						Git, Docker, Claude Code and Codex, used from this browser. Your files stay
						in it between sessions. It keeps running for a while after you close its
						last browser tab, then stops, and opening Portikus starts it again.
					</p>
					<ol>
						<li>
							Choose <strong>+</strong> beside Projects, then{" "}
							<strong>New project…</strong> or <strong>Clone repository…</strong>. If
							your course offers templates, <strong>From template…</strong> is there
							too. A project is a folder in{" "}
							<code className="pk-mono-body">~/projects</code>.
						</li>
						<li>
							In the middle of the screen, choose <strong>Open a terminal</strong> or{" "}
							<strong>Start Claude Code</strong>.
						</li>
						<li>
							Your files are listed on the right. Choose a file to open it in the
							editor.
						</li>
					</ol>
				</>
			),
		},
		{
			id: "student-layout",
			title: "The workspace layout",
			body: (
				<ul>
					<li>
						<strong>Projects</strong>, on the left, lists your project folders. A
						project's three-dots menu can rename, duplicate, download, archive or delete
						it, and holds its <strong>Recovery points…</strong>. Renaming a project
						renames its folder. An archived project keeps its files and comes back from{" "}
						<strong>Archived projects</strong> at the bottom of the list.
					</li>
					<li>
						<strong>The work area</strong>, in the middle, holds tabs: terminals, files,
						diffs and previews. The <strong>+</strong> at the end of the tab bar, named
						New tab, opens a terminal, Claude Code, Codex or a preview in the project's
						folder.
					</li>
					<li>
						<strong>The right pane</strong> has four tabs. <strong>Files</strong> is the
						project's folders, with your Git changes listed underneath.{" "}
						<strong>Checks</strong> runs your project's checks, such as its tests.{" "}
						<strong>Running</strong> lists programs listening on a port.{" "}
						<strong>Monitor</strong> shows CPU, memory, disk and network use, and the
						processes running.
					</li>
					<li>
						<strong>The status bar</strong>, at the bottom, shows the project folder,
						the Git branch, memory and disk use, and your workspace's state. Choose the
						state to open <strong>Your workspace</strong>, where you can restart or stop
						it, see its storage, and reset Docker.
					</li>
				</ul>
			),
		},
		{
			id: "student-keep-running",
			title: "Keep your workspace running while you are away",
			body: (
				<p>
					To leave a coding agent working while you are away, open{" "}
					<strong>Your workspace</strong> from the status bar. Under{" "}
					<strong>Keep running</strong>, pick how long, up to the limit your
					administrator set, and choose <strong>Keep running</strong>. Until then,
					closing the page or leaving it idle does not stop the workspace. The status
					bar shows when the hold ends, and <strong>End hold</strong> ends it early.
					Afterwards the workspace stops as usual, with the "Still working?" warning
					first.
				</p>
			),
		},
		{
			id: "student-terminals",
			title: "Terminals",
			body: (
				<>
					<p>
						A terminal is a real Linux shell in your project folder. It keeps running
						when you switch projects or close the browser, until the workspace stops.
						Typing <code className="pk-mono-body">exit</code> closes it.
					</p>
					<ul>
						<li>
							While a terminal has the keyboard, Tab goes to the shell. Press{" "}
							<kbd className="pk-mono-body">Alt+Shift+Q</kbd> to leave the terminal;
							focus moves to the tabs.
						</li>
						<li>
							A terminal's three-dots menu splits it right or down, moves it to a new
							tab, renames it, switches it between light and dark, or closes it.
						</li>
						<li>
							After the workspace stops or restarts, an old terminal says it ended.
							Choose <strong>New terminal here</strong> to open a fresh one in its
							place.
						</li>
					</ul>
				</>
			),
		},
		{
			id: "student-files",
			title: "Files and the editor",
			body: (
				<ul>
					<li>
						Choose a file in Files, or press Enter on it, to open it. The editor saves a
						few seconds after you stop typing; you can change the delay or turn
						auto-save off in Settings. <kbd className="pk-mono-body">Ctrl+S</kbd> saves
						at once.
					</li>
					<li>A Markdown file shows a preview beside the source.</li>
					<li>
						A letter beside a file shows its Git state: <strong>M</strong> modified,{" "}
						<strong>A</strong> added, <strong>D</strong> deleted, <strong>R</strong>{" "}
						renamed, <strong>?</strong> new and not yet tracked, <strong>!</strong> in
						conflict. <strong>Diff</strong> shows what changed since your last commit.
					</li>
					<li>
						Right-click a file, or press <kbd className="pk-mono-body">Shift+F10</kbd>,
						for new file, new folder, rename, move, download, upload and delete.
					</li>
					<li>
						<strong>Find in files</strong> is the magnifier at the top of Files.
					</li>
				</ul>
			),
		},
		{
			id: "student-previews",
			title: "Previews",
			body: (
				<>
					<p>
						When your web app is listening on a port, it appears under{" "}
						<strong>Running</strong>.
					</p>
					<ul>
						<li>
							<strong>Preview</strong> opens it in a tab inside Portikus. The button
							beside it opens it in a new browser tab.
						</li>
						<li>
							Only you can open your previews, after signing in. There are no public
							links.
						</li>
						<li>
							If Vite or webpack-dev-server refuses the preview host, the preview shows
							one line to add to its config file. Add it, restart the server, then
							choose <strong>Retry</strong>.
						</li>
						<li>
							Ports below 1024 cannot be previewed, and neither can a few reserved ones
							such as SSH, Docker and PostgreSQL. Run your web app on a port from 1024
							up, such as 3000 or 5173, then choose{" "}
							<strong>Choose another port…</strong> in the preview.
						</li>
					</ul>
				</>
			),
		},
		{
			id: "student-container-images",
			title: "Container images with GitHub Actions",
			body: (
				<>
					<p>
						Build and push your own images from GitHub Actions, then pull them here.
						Actions runs on GitHub's machines and pushes to ghcr.io with the
						repository's built-in <code className="pk-mono-body">GITHUB_TOKEN</code>.
						Put this in{" "}
						<code className="pk-mono-body">.github/workflows/image.yml</code>. The
						repository name in the tag must be lowercase.
					</p>
					<pre className="pk-mono-body whitespace-pre-wrap">
						<code>{IMAGE_WORKFLOW}</code>
					</pre>
					<p>
						After the first run, open the package on GitHub (your profile,{" "}
						<strong>Packages</strong>), and under <strong>Package settings</strong> make
						it public. Then, in a terminal here, run{" "}
						<code className="pk-mono-body">docker pull ghcr.io/owner/image:tag</code>,
						or start a Dockerfile with{" "}
						<code className="pk-mono-body">FROM ghcr.io/owner/image:tag</code>. No{" "}
						<code className="pk-mono-body">docker login</code> is needed.
					</p>
					<p>While your site caches ghcr.io, inside your workspace:</p>
					<ul>
						<li>
							<code className="pk-mono-body">docker push</code> to ghcr.io does not
							work. Push from GitHub Actions instead.
						</li>
						<li>Private ghcr.io images cannot be pulled. Make the package public.</li>
						<li>
							<code className="pk-mono-body">docker login ghcr.io</code> says it
							succeeded without checking anything.
						</li>
						<li>
							Tools other than Docker, such as curl, gh and ORAS, get certificate errors
							for ghcr.io.
						</li>
					</ul>
				</>
			),
		},
		{
			id: "student-checks",
			title: "Checks",
			body: (
				<p>
					Checks are commands your project lists in{" "}
					<code className="pk-mono-body">.portikus/checks.json</code>, such as{" "}
					<code className="pk-mono-body">npm test</code>. Open <strong>Checks</strong>{" "}
					and press the run button beside one to see its real output. The three-dots
					button, <strong>Edit checks</strong>, changes the list.
				</p>
			),
		},
		{
			id: "student-settings",
			title: "Settings",
			body: (
				<>
					<p>
						Open <strong>Settings</strong> from the menu under your name. Your settings
						follow you to any browser you sign in from.
					</p>
					<ul>
						<li>
							<strong>Profile</strong> shows what your institution sign-in provides, and
							lets you add a picture and links.
						</li>
						<li>
							<strong>Preferences</strong> covers the color scheme, editor auto-save and
							word wrap, terminal colors, screen reader mode and your workspace's
							timezone.
						</li>
						<li>
							<strong>Password</strong> appears when your account has a Portikus
							password, and changes it.
						</li>
					</ul>
				</>
			),
		},
		{
			id: "student-keyboard",
			title: "Keyboard and screen readers",
			body: (
				<>
					<h4>Keys</h4>
					<dl className="pk-help-keys">
						{KEYS.map((item) => (
							<div key={item.keys}>
								<dt>
									<kbd className="pk-mono-body">{item.keys}</kbd>
								</dt>
								<dd>{item.what}</dd>
							</div>
						))}
					</dl>
					<h4>What the terminal and editor cannot do</h4>
					<ul>
						<li>
							Terminals are silent to a screen reader until you turn on Screen reader
							mode in Preferences. With it on, output is read as plain lines of text:
							colors, bold, and layout are not announced.
						</li>
						<li>
							With Screen reader mode on, a terminal takes only typed keys: text from an
							emoji picker, dictation, or some on-screen keyboards is dropped.
						</li>
						<li>
							Full-screen programs such as vim, htop, and agent command lines redraw the
							whole screen, so a screen reader may read repeated or partial lines. There
							is no way to review what they draw other than moving through the lines.
						</li>
						<li>
							The editor reads the current line. Error underlines, the diff view, and
							inline hints are drawn visually; use Alt+F1 and the editor's own commands
							to reach them.
						</li>
					</ul>
				</>
			),
		},
		{
			id: "student-trouble",
			title: "When something goes wrong",
			body: (
				<ul>
					<li>
						<strong>Starting your workspace</strong> usually takes a few seconds. Your
						files are already saved.
					</li>
					<li>
						<strong>Waiting for room for your workspace</strong> means the server has no
						room for a new workspace yet, and administrators have been told. Leave the
						page open or come back later.
					</li>
					<li>
						<strong>Your workspace could not be started</strong>: read the sentence
						under the heading, which says why. If Docker's storage is full,{" "}
						<strong>Reset Docker…</strong> frees it and keeps your projects and home
						folder.
					</li>
					<li>
						<strong>You're disconnected from your workspace</strong>: Portikus is trying
						to reconnect. If no window reconnects before the time shown, the workspace
						stops. Your files are saved, but running terminals and previews end. Choose{" "}
						<strong>Reconnect now</strong> to try at once.
					</li>
					<li>
						<strong>Still working?</strong> You have not typed or clicked in Portikus
						for a while, so the workspace will stop soon. Programs running on their own
						do not count. Choose <strong>Keep working</strong>, or press any key, to
						keep it running.
					</li>
					<li>
						<strong>Your workspace has been slowed down</strong>: it kept its CPUs busy
						for a long time. The notice says how it gets back to full speed. Stop a
						program you do not need from Monitor.
					</li>
					<li>
						<strong>Your workspace has been near its memory limit</strong>: if it runs
						out, the biggest program is stopped. Stop a program you do not need from
						Monitor.
					</li>
					<li>
						<strong>You deleted or broke something</strong>: open the project's
						three-dots menu and choose <strong>Recovery points…</strong>. Restoring one
						puts back every file in the folder, Git's own records included, so commits
						made since then leave the folder too. Portikus saves the current state as a
						new recovery point first, so you can go back. It never makes a Git commit
						for you.
					</li>
					<li>
						<strong>Your session ended</strong>: sign in again. Your projects are where
						you left them.
					</li>
					<li>
						<strong>Something else</strong>: every message that pops up is kept in{" "}
						<strong>Notifications</strong>, in the menu under your name. Read it again
						there, then tell your instructor what it said.
					</li>
				</ul>
			),
		},
	],
};
