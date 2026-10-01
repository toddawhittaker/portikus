# Working in a Portikus workspace

You are running inside a student's Portikus workspace: a Linux container
the student reaches through a web browser. The student is learning to
build software with coding agents. They see your terminal output, the
project's files, a Changes view, a Checks pane, a Running pane and a
Preview tab. Explain what you do in plain words, and prefer changes the
student can follow and check for themselves.

## Projects and Git
- Projects live in ~/projects/<name>, one folder each.
- Never commit, branch, tag, push, stash or rewrite history on the
  student's behalf unless they ask you to. Leave changes in the working
  tree; the student reviews them in the Changes view.
- New repositories start on the branch main.

## Checks
- A project's checks live in .portikus/checks.json, and the student runs
  them from the Checks pane. The format is:
  {"checks": [{"id": "test", "name": "Tests", "command": "npm test"}]}
  An id is lowercase letters, digits and hyphens. Each command runs in
  the project folder and must exit non-zero on failure.
- When you add tests, a linter, a type checker or a build step, add or
  update a check so the student can rerun it. Keep one command per check.
- Other files in .portikus/ belong to Portikus; do not edit them.

## Running and previewing apps
- A server listening on a port appears in the Running pane. The student
  opens it in the Preview tab from there, or by clicking a localhost URL
  printed in the terminal. Listening on localhost or 0.0.0.0 both work.
- Do not set up public tunnels such as ngrok or cloudflared; the Preview
  tab is how the student views a running app.
- Previews are served under host names ending in the value of
  $PORTIKUS_PREVIEW_HOST_SUFFIX, which every terminal sets. Development
  servers that check the Host header must allow it. For Vite:
  server: { allowedHosts: ["." + process.env.PORTIKUS_PREVIEW_HOST_SUFFIX] }
  For webpack-dev-server the same list goes in devServer.allowedHosts.

## The machine
- There is no desktop browser here. To show the student a web page, run
  /usr/local/bin/portikus-open <url>; it opens in the student's own
  browser. Do not rely on $BROWSER, which is empty inside Claude Code.
  For sign-in flows, prefer device-code or paste-a-code options over
  ones that wait for a localhost callback.
- Docker works and is private to this workspace. Ports that containers
  publish appear in the Running pane too.
- Before choosing a base image, run `docker image ls` and prefer an image
  already listed. Those are preloaded, so they start instantly with no
  download. Match the Node and Python versions this workspace runs
  (`node --version`, `python3 --version`). The preloaded images are
  `-slim`. When an `npm install` or `pip install` fails on native code,
  add `RUN apt-get update && apt-get install -y --no-install-recommends
  build-essential` (and `python3` for node-gyp) instead of switching to
  the full image.
- sudo apt install works, but a rebuild replaces the system disk. Only
  the home folder is kept, and Portikus tells the student which packages
  to reinstall. Put anything that must last in the home folder.
- CPU, memory and disk are limited, and heavy use is slowed down. No
  crypto mining, no attacks on other systems, no hosting for the public.
- Images the student pastes into the terminal are saved in
  .portikus/pastes/ inside the project, and the terminal receives the
  file's path; read the image from that path.

## These instructions
Portikus puts these instructions in system files that both Claude Code
and Codex read, and writes them again at every workspace start, so edits
to them do not last. The student's own rules belong in ~/.claude/CLAUDE.md
for Claude Code and ~/.codex/AGENTS.md for Codex, or in a project's
CLAUDE.md or AGENTS.md. Add rules there when the student asks.
