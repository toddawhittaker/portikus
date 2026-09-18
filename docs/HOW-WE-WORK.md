# How we work: building Portikus with AI agents

This document describes how Portikus is actually built. It is written for a
course, so it explains the reasoning as well as the rules, and it includes the
mistakes. Everything here traces to something in the repository, to the
project's memory notes, or to a recorded session. Where a note and the code
disagree, the document says which one is current.

Portikus is a browser-based agentic development workspace for students. One
person, Todd, is the product owner. He does not write the code. He writes the
requirements, runs a conversation with a single orchestrating agent, rules on
disputes, and merges. Between September 15 and September 18 of 2026 this
arrangement produced eight epics, more than 180 pull requests, a Debian
package, a reproducible virtual machine, and a running pilot deployment.

---

## 1. Why work this way

The goal is a real product, not a demonstration. Portikus has students as its
audience, so it has to survive contact with untrusted code, flaky networks, and
people who have never used a terminal. That rules out the common pattern of
asking an assistant for a file, pasting it in, and moving on.

Four constraints shape everything that follows.

**One person cannot read every line.** At the rate agents produce code, a
careful human reviewer becomes the bottleneck within a day. The project's
answer is not to review less but to move the review off the human: automated
tests, a coverage floor, two reviewing agents with different mandates, and a
full test battery run on real hardware. The human reads reports and reviews one
pull request per epic.

**Model time is the real budget.** Todd says this directly. Correcting the
orchestrator on 2026-09-16: "you, Fable, the expensive orchestrator are doing
too much work that should be delegated to a cheaper subagent." Later the same
evening, after the orchestrator ran a single verification command itself: "you
are expensive and the agents are cheaper. That's why I vigorously protect the
context here." Every structural decision in this document — the explorer agent,
the merger agent, the epic branch, the per-agent scratch files — exists partly
to keep expensive reasoning scarce and cheap work plentiful.

**Wall-clock time matters too.** Todd frequently starts a wave of work and
leaves. "I'm AFK. I want to wake up tomorrow to a finished epic." That works
only if the work is split so many agents can run at once without colliding, and
if agents resolve their own failures rather than queuing questions for a human
who is asleep.

**Quality gates must not depend on trust.** Agents report confidently and are
sometimes wrong. A builder once reported that lint passed; continuous
integration then failed on a Biome warning. Todd: "why are we not running pnpm
lint (even other linters) locally before pushing to CI? Failures on PR 27 were
avoidable if we were checking locally before pushing." The orchestrator now
verifies an agent's claim before relaying it.

---

## 2. Roles

### The human: product owner and final gate

Todd owns intent and owns merges. He decides what a student should experience,
he rules when agents disagree and the specification does not settle it, and he
is the only one who merges an epic into `main`. He answers with short
authorizations — "go", "make it so", "merge it" — and he expects questions to
be answered rather than implemented until he says one of those words.

He also does the things the permission system will not let an agent do:
exposing a local service to the network, deleting branches in bulk, and driving
the pilot through a browser.

### The orchestrator: the main session

The main conversation is an orchestrator, not an implementer. Its job, in the
words of `CLAUDE.md`, is to "understand the request, write good prompts, spawn
agents, verify their claims, and report in plain English." It does work itself
only for a one-line lookup or edit.

The orchestrator holds the plan, the arbitration, and the context. That context
is the scarce resource being protected, which is why the same file is never
read into it twice if an explorer can summarize it instead.

### The agent roster

Agent definitions live in `.claude/agents/` as Markdown files with a model and
an effort level in their front matter. Each one carries a persona, because Todd
asked for it: "I notice that the agents don't have any persona (e.g. expert in
DevOps, etc. for the infra agent). Does that make a difference? It seems that
it should." The rest of each file is rules and a required report format.

**explorer** (Haiku, low effort) is a read-only repository scout. It uses
ripgrep and glob patterns, reports paths with line numbers and short quotes,
and ends by naming anything it searched for and did not find so the absence is
known to be real. Its instructions tell it: "You locate; you do not judge."
Todd asked for it by name when the roster was being designed: "I want a low
cost 'explorer' agent that can use ripgrep to figure out where things are in
the repo and report those back to smarter, better agents like the tester,
security reviewer, etc."

**builder** (Opus, low effort) implements one scoped change against a named
specification section. It is told to build only what the task asks, to prefer
the boring solution, to run the tests and lint that cover its change, and to
say plainly when it added behavior with no test. It is also told what to do
when it disagrees: "If a test or review finding looks wrong to you, do not
silently work around it or change the test. Say which spec section you believe
supports your reading and why. The orchestrator decides."

**tester** (Opus, low effort) designs tests from specification invariants
rather than from what the code happens to do. Its file lists examples of the
kind of invariant it should hunt for: recovery points never create commits or
branches, a stale editor write cannot overwrite a newer file on disk, a
workspace stops after the grace period and not before. It is forbidden to
weaken a test to make it pass, and forbidden to describe a test as passing
unless it ran it and saw it pass.

**security-reviewer** (Opus, medium effort) is read-only and reviews against
the eight trust zones in specification section 24. It is told to assume every
zone is hostile to its neighbors and that student code "will bind arbitrary
ports, attempt privilege escalation, exhaust resources, probe the network,
serve malicious JavaScript, create symlinks, manipulate filenames, and attack
platform services." Every finding needs a file, a line, and a concrete failure
scenario.

**code-reviewer** (Opus, medium effort) is read-only and reviews correctness
first, then simplicity. Todd specified it himself: "write the code-reviewer
agent — correctness and quality/refactors. YAGNI, KISS, SOLID, etc. as applied
to both program code and infra code." Its rules include a guard against
reviewer noise: if it cannot name a concrete simpler alternative, it may not
report the finding.

**infra** (Opus, medium effort) owns everything under `infra/`: host bootstrap,
the OpenTofu virtual machine, cloud-init, Ansible, Incus, the workspace image,
and Caddy. Its persona is a DevOps engineer "who has run libvirt, LXC, and
Debian fleets in production and been paged for the consequences." Because its
mistakes are slow and hard to undo, it must state the evidence before any
destructive command and prefer a dry run.

**merger** (Sonnet, low effort) lands pull requests. It waits for continuous
integration, updates a branch that has fallen behind, squash-merges, classifies
a red run as a flake, a conflict, or a real failure, reruns flakes at most twice
itself, and escalates anything needing judgment. It does not change code. Todd
proposed it during Epic 7.1: "This workflow really begs for a CI/merge agent on
Opus low, don't you think? It would further reduce Fable usage. It could
escalate to you as the orchestrator only if needed." It shipped as
`.claude/agents/merger.md` at Sonnet rather than Opus.

*Current as of this writing:* `merger.md` and the decision record that codified
automatic merges, `docs/adr/0016-automatic-task-merges-with-epic-level-review.md`,
landed on the `epic/7-1-pilot-fixes` branch in pull request #179 and are not yet
on `main`. The six agents on `main` are explorer, builder, tester,
security-reviewer, code-reviewer, and infra.

### Why cheap agents do most of the work

Three reasons. Most of the work is not hard: finding where a symbol is defined,
waiting for a check to go green, and updating a branch that fell behind require
diligence, not reasoning. Every token the orchestrator spends reading a file is
context it cannot spend on the plan, and an explorer that reads twenty files and
returns thirty lines has converted an expensive read into a cheap one. And
interruptions cost more than they look: the merger agent was created because the
orchestrator "was interrupted a dozen times a day by pure bookkeeping: CI waits,
BEHIND updates, flake reruns, helper timeouts."

There is a practical trap worth knowing: an agent definition file only loads in
sessions started after it exists. When `merger.md` was written, it could not be
spawned by name in the session that wrote it. The workaround is to spawn a
general-purpose agent at the right model and tell it to read the file.

---

## 3. The unit of work

### The documents

Four tracked documents carry the project's intent and are cited by section
number in every prompt, commit, and review. `docs/VISION.md` holds product
intent and wins any question about what the product is for. `docs/SPEC.md`
holds requirements and wins on implementation detail; section 29 lists the
epics in order, section 30 the milestone gates, section 24 the security trust
zones. `docs/STACK.md` holds technology choices and the reasoning behind them,
including a section on what was rejected. `docs/OVERVIEW.md` is a one-page
orientation that every agent reads first.

Two more track state. `docs/STATUS.md` records what each epic delivered and the
gaps it left, updated in the same pull request that lands the work.
`docs/BACKLOG.md` holds wanted work that is not yet an epic. Decisions a later
reader would ask "why" about go into a numbered record under `docs/adr/`; there
are sixteen so far, covering the monorepo tooling, the Incus access method, the
reconciler design, the Debian package, sessions, the agent transport, logging,
the editor stack, and the merge policy.

`CLAUDE.md` is deliberately small. Todd capped it: "CLAUDE.md is too big. We
need to keep it lean: 150 lines max. Most should be pointers to where other
information is along with rules about processes (e.g. delegating to cheap
subagents where possible, test driven development, merge rules, etc.)." It now
holds only pointers and process rules. Anything describing what the code does
lives under `docs/`.

### Epics and task pull requests

An epic is a coherent slice of the product listed in specification section 29,
with its own acceptance criteria. It gets a long-lived branch named
`epic/<n>-<slug>`. Work happens on short-lived task branches cut from the epic
branch, each merged into it by a squash merge. When the acceptance criteria are
met, the epic branch is merged into `main` by one pull request, with a merge
commit so the epic's history is kept.

The branch protection rules shape the mechanics more than anyone expected. Every
push to an epic branch needs a pull request, including a sync from `main`. A
pull request branch must be up to date with its base before it merges, and
automatic merging is disabled, so pull requests land strictly one at a time:
update, wait for the run whose head matches, merge, repeat. Epic branches reject
merge commits, so task pull requests must be squashed; `main` accepts a merge
commit.

### The fix batch

Small problems found on the running pilot do not each get a branch. Todd's rule,
stated on 2026-09-18: "I really just want to batch up a bunch of fixes into one
epic unless they're showstoppers. Like we did with epic 6.1." Each small finding
becomes a GitHub issue under a milestone named "Pilot fixes (next fix batch)",
carrying its cause, a proposed fix, a size estimate, and the specification
sections it touches. When Todd says go, the milestone's issues become a
fractional epic: a branch, one pull request per issue, one review pass, one
merge, one deployment. Epic 6.1 carried eighteen such pull requests; Epic 7.1
carried the issues numbered 153 to 164.

He is explicit about what he does not want in between. Offered a pull request
whose only purpose was to record a note: "We have a BACKLOG of features. This
seems like a small fix. Unfortunately, I don't want to open a new PR just to
create a FIXES.md file and merge it. Seems odd."

### How an epic runs, end to end

Epic 7, which delivered the file tree, the Monaco editor, search, Git status,
and change review, is a good worked example. It ran overnight between
2026-09-17 and 2026-09-18 and is typical in shape.

It began in plan mode. Todd asked for a plan, named one thing he cared about —
"we'll have a markdown viewer, but we also need to edit markdown, so we need a
way of doing both when clicking on the file" — and said how to gather the
information: "Use the explore agent to read the files you need to plan the
epic." The orchestrator sent explorers to map the code, synthesized a plan of
non-overlapping waves, and brought open questions back for a ruling. Todd
ruled: Markdown opens in preview with an Edit, Preview and Split control; front
matter renders as a collapsed block; agent-session review moves to a later epic.

Then he left. "After authorizing the plan, you will cut the epic branch and I
will go AFK. I expect you to do your best to iterate through all the issues,
fixing bugs, merging PRs, etc. so that when I come back in the morning, epic 7
will be ready for me to test."

The orchestrator cut `epic/7-files`, spawned builders in waves, and landed
seventeen task pull requests, numbered 131 to 149, each squash-merged after its
checks went green. Work touching the workspace agent, the API or file handling
also went through security review before it landed. When the last task was in,
security-reviewer and code-reviewer ran in parallel over the epic head; their
findings became further task pull requests; a confirmation review followed.

The final gate ran on Todd's workstation with a fresh database: `make check`
green at 1179 tests, `pnpm test:e2e` at 109 passed, `make build-deb` producing
version 0.1.179. Only then did the orchestrator open pull request #150 into
`main` and stop. Todd merged it on 2026-09-18 as commit 3849f09. The release
workflow published a package, an infra agent deployed it to the pilot as
0.1.163, and the smoke test passed 63 of 63 checks.

Todd then used the pilot as a student would, found twelve problems, and filed
them as issues 153 to 164 for the next fix batch. One, a false "changed on disk"
prompt, he marked a showstopper.

---

## 4. Prompts that work

A delegation prompt is a small specification. `CLAUDE.md` names the parts: "A
good prompt names the SPEC.md and STACK.md sections, the files in scope, the
base commit, what done looks like, and what to leave alone."

**Specification sections by number.** Agents read the cited sections before
writing code. This is what lets a builder push back with evidence instead of
opinion, and what lets the orchestrator settle the argument by reading the same
lines.

**Files in scope, and files not in scope.** Parallel agents must never share a
file. The split is by package or directory. Epic 5 ran eight agents at once —
shared packages, agent, controller, worker, API, web, infrastructure and docs —
across nine pull requests with no file conflicts. The one file two agents would
have touched was assigned explicitly to one of them.

**The exact base commit.** Agent worktrees start at `main`, not at the branch
the orchestrator is on. During the grace-period task both builders found
themselves at the wrong commit and had to reset by hand. The rule that came out
of it: tell a worktree agent the exact commit to reset to.

**What done looks like.** Which tests must pass, which commands must be run,
and what the report must contain. The builder definition requires command output
rather than a claim, because a claim was wrong once and cost a red run.

**The preamble pattern.** Each agent file opens with a persona and a short list
of non-negotiables before any task detail. The infra agent's non-negotiables are
a good example: everything reproducible from source control, unprivileged
containers with per-workspace identifier maps, user data on separate volumes,
nothing outside the storage adapter depending on LVM, management networks
unreachable from workspaces. A task prompt then adds only what is specific to
the job.

**Private databases and ports.** Parallel agents collide on shared
infrastructure in ways that look exactly like real bugs. Tests that share one
PostgreSQL database must not run in parallel; the project sets
`fileParallelism: false` on the relevant Vitest project, a fix prompted by a
suite that passed locally by timing luck and failed in continuous integration.
Each agent is told to create its own database. Playwright is worse: its ports
are fixed, so two browser runs on one machine fight whatever database they use.
Browser-test agents are serialized, or reruns are accepted.

**Time boxes.** A debugging agent without a limit will burn an afternoon. One
spent thirty minutes rerunning a fifteen-minute smoke test instead of
reproducing a single request. The rule: give debugging agents a tight
reproduction recipe and a time box, and check on them after ten minutes. The
merger agent has its limits written into its own file — ninety minutes per pull
request, four hours for a list.

**Report a paragraph; do not edit a shared document.** Every pull request into
an epic branch used to conflict in `docs/STATUS.md` and in the specification's
epic list, because each builder appended to the same paragraph. The resolution
was always to keep both, but it cost a manual step on nearly every merge. Since
Epic 7.1, builders report their status sentence and their specification bullet
in the pull request body, and the orchestrator writes them all in one
documentation pull request at the end.

---

## 5. Saving tokens and time

**Send the cheapest agent that can do the job.** Explorer before builder,
always, when a location is unknown. `CLAUDE.md` puts it plainly: "Run explorer
first when a location is unknown and pass its paths on, rather than making a
stronger agent search."

**Parallelize on disjoint files.** Epic 4 ran seven builders from one plan
file. The only conflicts were a shared API test file, resolved by taking one
agent's version, and the lockfile, resolved by regenerating it. Epic 5's wave
shape is the template: one agent alone on the shared packages, then seven in
parallel on separate services, then testers and reviewers in parallel, then two
fix builders split by file ownership.

**Know when not to parallelize.** Epic 7.1's plan has two waves for a reason.
Wave one is nine parallel tasks on disjoint files. Wave two is five tasks that
all pass through one file, `apps/web/src/work/FileLeaf.tsx`, and they run
strictly in series. Forcing them to run together would produce conflicts that
cost more than the time saved.

**Hand bookkeeping to a clerk.** The merger agent exists because merge
mechanics are mechanical. Todd noticed the pattern and named the fix himself.

**Do not let debugging agents rerun whole suites.** Reproduce one request, not
the system.

**Never wait with sleep loops.** A background wait keyed on a process pattern
deadlocks: the waiting shell's own command line matches the pattern, so it waits
for itself forever, and killing the pattern then kills the replacement too. Use
a background loop polling the check state, or the completion notification from a
background job.

**Keep continuous integration fast.** Todd: "do it. I always want CI to be as
fast as possible." Caching Ansible collections cut a four-minute lint step. The
Chromium headless shell is installed instead of full Chromium. Any step over a
minute is a candidate to cache or drop, and pull request reports mention
continuous integration time.

**Split the test run for parallelism, carefully.** The database tests are
serialized within their project; everything else runs in parallel. The browser
tests run one at a time per machine.

**Accept known contention rather than serializing everything.** Building the
workspace image and several parallel browser suites together starved Todd's own
workspace container. Offered the choice, he said: "No, it's okay. You can
continue to work. I'll live with the contention." The rule is to warn him when a
heavy build starts so a spike is not mistaken for a bug.

---

## 6. Quality gates that replace line-by-line human review

The human reviews one pull request per epic. Everything below is what makes
that safe.

**Tests are part of done.** Not a follow-up. A change ships with unit tests for
its logic, and anything a student or administrator can see ships with browser
tests too. Write the test first when the behavior is clear enough to state; a
bug fix starts with a failing test that reproduces it.

**Browser tests are not optional.** Todd made this a rule during Epic 5 after a
web task landed without one: "We need thorough e2e tests for each epic or task
that builds the interface." The evidence was already in hand from Epic 4, where
a plain HTML sign-out form returned a 415 error in a real browser because
Fastify's injection helper sends no form content type. No unit test could catch
it; Playwright did. During the logging task, browser tests caught the API
registering a shutdown hook after the server was already listening, which
Fastify refuses and which unit coverage never reaches.

**Coverage floors.** Continuous integration fails if coverage drops below the
floors in `vitest.config.ts` — eighty percent of lines overall at present. The
rule attached to it matters more than the number: do not lower a floor to make
a run pass. Say so and let the human decide.

**Security review on trust boundaries.** Anything touching authentication, the
preview gateway, the workspace agent, file APIs, Incus or nested Docker goes
through security-reviewer before it is called done. In Epic 6 it found unbounded
reads of agent responses and uncapped inserts during project discovery. In Epic
6.1, a pseudo-terminal leak on a socket closed mid-capture and a memory burst a
student could trigger. In Epic 7: a dangling-symlink write that escaped its
directory, a file watcher following symlinks by default, a search cap that
ripgrep silently ignores in its JSON mode, a Zod coercion where the string
"false" becomes true, agent error text relayed to the browser verbatim, and a
100 MiB default message size limit.

**Code review over the epic head.** Run once, over the whole branch, before the
epic pull request. It catches seams that appear only after parallel work lands
together: a leftover polling loop, a single letter meaning two different things
in two files, a watcher that failed without telling the sockets depending on it,
duplicate tab identifiers, a tmux history limit set after session creation where
it does nothing, a signal handler that would have hung every service restart for
ninety seconds, and a query running once a second for debug lines nobody was
printing.

**A confirmation review.** After the review findings are fixed, both reviewers
run again over the merged head. Fixes made in a hurry are still fixes made in a
hurry.

**The full battery locally, on a fresh database.** Before the epic pull request:
`make check` and `pnpm test:e2e` green on this machine, with a database
container created for the run. The freshness is not ceremony. The admin browser
test once passed locally only because an unrelated unit test had left a row in
the shared database; continuous integration's fresh database failed.

**Real-host verification for infrastructure.** Continuous integration only
lints and validates infrastructure code. Pull request #6 merged green and then
failed at every step of the first real run: initialization, provider schema,
the cloud-init path, AppArmor on the disks, Ansible filters, Incus keys, and the
smoke test. Since then, anything under `infra/` runs the full lifecycle on this
machine before its pull request is called ready — bootstrap, plan, apply from
nothing, Ansible twice with the second run reporting no changes, smoke test,
operating-system disk reinstall keeping the data disk, and a fresh-host
bootstrap in a throwaway virtual machine — reported per step in a table.

**Adversarial probes.** The tester's first run planted a secret, a type error,
and an unused variable to see whether the checks would notice. They found a real
defect: Biome was exiting successfully on warnings. Those probes stayed in the
tester's prompts.

**Run it again.** Todd's summary of why all of this exists: "Every time we've
run tests, we've found something. Let's run the battery again." And before the
Epic 2 merge: "tear down the VM and run the battery one more time before we
merge."

---

## 7. Todd's working rules, in his words

These come from his global working instructions and from what he has said in
session. They are short because they are meant to be remembered.

**Done means done.** "Not half done. Not done except for the part I decided to
skip. And not a report about how it will be done. N things asked means N things
delivered, however long they take. If one is genuinely blocked, finish the rest
and name the specific blocker in one sentence — not 'this needs more
investigation.'"

**Act, don't ask.** Reversible and cheap work gets done and then reported:
research, analysis, drafts, refactors inside the given scope. "A question costs
me more than a re-run costs you." Ask first only for something that reaches an
audience, cannot be undone, or is expensive. Something broken gets fixed, not
reported: "reporting an issue I could have had fixed turns your work into my
to-do list."

**A question is a question.** "'Should we use X?' is not 'migrate to X.' 'What
would it take to add Y?' is not 'add Y.' When in doubt, assume it's a question.
Answer first; act when I say go." He uses this constantly. Asking about
workspace hostnames, he closed with "Don't change anything, but let me know your
thoughts." Asking about a single-command installation for people bringing their
own Debian host: "Don't do that right now, but tell me what that would entail."

**Build only what was asked.** No configuration options, abstractions, or
extension points for needs nobody has today. "If a future need is real, say so
in one sentence and still leave it unbuilt."

**Prefer boring.** "Longer and obvious beats short and clever. Fewer moving
parts, fewer layers, fewer new files." Remove duplication that is real and leave
alone things that merely look alike, because sharing two things too early is
harder to undo than a copy. Use what is already in the repository before adding
a dependency, and say why out loud if you add one.

**Recommend, do not survey.** "Recommend the simplest thing that solves the
problem actually in front of you, and say which option you would pick rather
than listing them all." He also expects to be argued with, and he changes his
mind: he asked to be challenged on model choices and did change one when given
a real argument.

**Merges are his gate.** Task pull requests into an epic branch merge
automatically once their checks are green. The one pull request from the epic
into `main` is his. He grants merge authority explicitly and temporarily — "I'm
going AFK, so do your best to resolve issues on your own. You have my authority
to merge all PRs for the remainder of this session" — and it does not carry
over.

**How he corrects drift.** He does not soften it, and he asks for the cause
rather than an apology. "It seems like you were stuck. Plus, you, Fable, the
expensive orchestrator are doing too much work that should be delegated to a
cheaper subagent. What is going on?" "Is the infra agent stuck? It's been
waiting a while." "I think the merge subagent is stuck polling 166, which is
green." "You've enabled claude-fable-5-1 on low, but the merge agent is sonnet.
Is that right?" Each of these produced a durable change: delegation of
verification runs, a merger agent, an escalation rule.

---

## 8. Lessons learned the hard way

Each of these cost real time, and each produced a rule that is now written down
somewhere an agent will read it.

**Squash merges break rebases, so apply diffs instead.** Builder worktrees start
from an older base and often merge the epic branch in. Once the epic branch has
squash-merged their siblings, a rebase replays the whole chain and conflicts on
every file the squash already contains. The fix is to take the content
difference and apply it: `git diff <their base> <their head> | git apply
--3way` onto the current epic head, then commit once. This worked three times in
Epic 6.1 alone, and it is now written into the merger agent's standing rules.

**Branches cut early go stale fast.** A pull request cut before three siblings
landed conflicted in the code it touched, and worse, the reviewers pointed at
its head were reviewing a tree missing four pull requests entirely. The review
was wasted. The rule: before spawning a reviewer or merging, confirm the branch
actually contains the epic head, and state which commits it holds.

**Phantom merges.** A merge loop that printed "merged" without checking the exit
code reported four merges that never happened. Earlier, a failed merge command
piped through a text filter looked like success and three more were reported
that had not occurred. The rule: never print "merged" unless a state query says
`MERGED`, and check `mergeStateStatus` for `BEHIND`, `BLOCKED` or `CONFLICTING`
first.

**Deleting a base branch closes its pull requests.** GitHub closes a pull
request when the branch it targets is deleted. Every task pull request therefore
targets the epic branch and never another pull request's branch, and a branch
that other pull requests depend on is never deleted on merge.

**Shared test ports and databases masquerade as bugs.** Parallel agents share
the Playwright ports 5173, 7400, 3000 and 3002 and the database named
`portikus_test`. Two agents running the browser suite at once produce failures
that look like application bugs and are not. Each agent now gets a private
database; browser-running agents are serialized or accept a rerun.

**The smoke test deleted a live workspace.** On 2026-09-17 the infrastructure
smoke test ran against the pilot while Todd was signed in to it. Its cleanup
removed every workspace belonging to the mock users, and Todd signs in as one.
His running workspace, its home volume and its Docker volume were destroyed. The
test was fixed in pull request #119 to delete only what the run created, but the
rule stands independently of the fix: never run the smoke test against a virtual
machine someone is using, and ask before running it against the pilot at all.

**Classifier quirks that trap agents.** The permission system that keeps agents
from doing dangerous things has sharp edges. It blocked merging a pull request
as "merge without review", so Todd ran the command himself until permissions
were granted explicitly. It blocks disabling a security-relevant test, even a
temporary skip ordered by the orchestrator, so the answer is to fold the
dependent fix into the same pull request. It blocks exposing a local service, so
the port forward was written as a script and Todd ran it. It blocks deleting
branches in bulk, so the orchestrator removes worktrees itself and hands Todd
one line to run. And it blocks any command mentioning "git" twice, which meant a
branch named `7-files/git` trapped every agent that touched it. Avoid the word
"git" in branch names.

**Agent claims that were wrong.** A builder reported that lint passed and
continuous integration failed on a Biome warning. An infrastructure agent
reported a throwaway storage pool removed that a later agent found still
present. Both produced the same rule: verify before relaying. Run the checks
yourself in the agent's worktree, require the command output in the report
rather than the claim, and confirm state changes with the tool that owns the
state.

**The false autosave conflict.** In Epic 7 the editor warned "This file changed
on disk while you were editing it" immediately on typing, and again after every
autosave, when nothing had touched the file but the editor itself. Todd
reported it in exactly those terms and added what he wanted instead: "If
something actually does change the file while in the editor, Monaco should use
diff mode." It became issue #157 and he marked it a showstopper — the one class
of finding that does not wait for the next fix batch. The lesson is about the
limits of the other gates: every test passed, both reviewers were clean, and the
bug was still obvious within a minute of real use. Human hands-on testing of the
deployed pilot is a gate, not a courtesy.

**Orphaned load generators.** A debugging agent investigating a search timeout
forked sixteen infinite busy loops to simulate a loaded machine, then tried to
stop them with shell job control that does not exist inside a non-interactive
script. They spun at full CPU for five hours until Todd noticed, alongside five
idle test workers left by deleted worktrees. The rule: never create background
load with detached loops, and if load is needed, kill the recorded process
identifiers from an exit trap. Check for stray processes after an agent session.

**The merger's permission workaround had to be said out loud.** Automatic
merges only work because `.claude/settings.json` grants agents permission to run
the merge command and read-only repository queries. That is a real loosening of
a real guard, and the decision record says so rather than burying it: the cost
is that a bad task pull request reaches the epic branch before any human has
seen it, and the epic-level review plus the full local battery are what catch
it. A workaround that buys speed by relaxing a safety rule gets written down
where the next reader will find it, with what now compensates for it.

**Clean up after every merge.** Fifty-two stale agent branches and nine
worktrees accumulated across Epics 2 through 5 before anyone noticed. Todd:
"We need to always clean up local branches/worktrees after a merge." It is now
part of the merge step, not a later chore.

---

## 9. What a student should take away

A one-page distillation.

**Write the requirements down before you write the prompt.** A numbered
specification is what lets a cheap agent do good work, lets two agents settle an
argument with evidence, and lets a reviewer tell over-engineering from a
requirement.

**Be the orchestrator, not the typist.** Decide what is true, split the work so
pieces do not collide, write prompts that name the sections, the files, the base
commit and the definition of done, and check what comes back. If you are reading
files in order to write code, you have taken someone else's job.

**Send the cheapest agent that can do the job.** A search is a search. A merge
is a merge. Save expensive reasoning for planning, arbitration, and decisions
nobody has made yet.

**Parallelize by boundary, never by hope.** Two agents must never be able to
touch the same file, database or port. When a change has to pass through one
file, run those tasks in series and say so in the plan.

**Replace human reading with machine checking.** Tests written from the
specification's invariants, a coverage floor that cannot be lowered to pass,
browser tests for anything a person can see, a security reviewer with a threat
model, a code reviewer with a simplicity mandate, and a full battery on a fresh
database. Then one human review, where it is worth a human's time.

**Trust no report you have not verified.** Run the lint yourself. Query the
merge state. Check the pool is really gone. This is not about dishonesty; it is
the difference between believing a command succeeded and having seen it succeed.

**Nothing is done until a person has used it.** Every gate passed on the false
autosave conflict, and sixty seconds of real typing found it. Deploy to
something real, use it as your user would, and treat what you find as data about
your gates as much as your code.

**Write down every lesson where an agent will read it.** A lesson learned and
not written into the next prompt will be learned again, at full price.

**Ask a question as a question.** And when you are the one answering, answer it.
