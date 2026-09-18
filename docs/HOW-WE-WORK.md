# How we work: building software with AI agents

This is a guide to building real software by directing artificial-intelligence
agents instead of typing code yourself. It is written for someone who has never
programmed. If you know what a file is and what a web page is, you know enough
to read it.

Every technical word is explained the first time it appears, and there is a
glossary at the end. The guide is not a theory. It is a working method that came
out of building one real product over several months, and it includes the
mistakes, because the mistakes are where the rules came from.

A note on two words used constantly below. An **agent** is an AI assistant that
has been given a job, a set of tools, and permission to use them on its own: it
can read files, change them, run programs, and report back. The **orchestrator**
is the one conversation you personally have. It does not write the software. It
plans, splits the work, hands pieces to other agents, checks what they send
back, and tells you in plain language what happened. Throughout this guide, "the
owner" means you: the person who decides what the product should be and who
approves the final result.

---

## 1. Why work this way

The goal is a real product that real people use, not a demonstration. Real
products have to survive bad networks, strange input, people who do the
unexpected, and attackers who do the unexpected on purpose. That rules out the
familiar pattern of asking an AI for a chunk of code, pasting it in, and hoping.

Four facts shape everything that follows.

**One person cannot read every line.** Agents produce work far faster than a
careful human can read it. Within a day, the human becomes the traffic jam. The
answer is not to read less carefully. It is to move most of the checking off the
human and onto machines: automated tests, a minimum standard those tests must
meet, two separate reviewing agents with different jobs, and a full run of every
check on a real machine. The owner then reads reports and personally reviews one
large batch of work at a time.

**Model time is the real budget.** A **model** is the particular AI doing the
thinking. Models come in sizes: larger ones reason better and cost more per unit
of work, smaller ones are cheaper and faster but shallower. Work is billed in
**tokens**, which are roughly chunks of a word — every word an agent reads and
every word it writes costs tokens. So reading a large file into the expensive
planning conversation is a real expense, and doing it twice is waste. The owner
of the project this guide came from put it bluntly to the orchestrator: "you,
the expensive orchestrator, are doing too much work that should be delegated to
a cheaper subagent," and later, "you are expensive and the agents are cheaper.
That's why I vigorously protect the context here." Almost every structural idea
in this guide exists partly to keep expensive thinking rare and cheap work
plentiful.

**Wall-clock time matters too.** The owner often starts a wave of work and walks
away: "I'm away from the keyboard. I want to wake up tomorrow to a finished
batch of work." That only works if the work is divided so many agents can run at
the same time without stepping on each other, and if agents fix their own
failures instead of stacking up questions for a person who is asleep.

**Quality checks must not depend on trust.** Agents report confidently and are
sometimes wrong. In one project an agent reported that the code-style checker
had passed; the shared automated check then failed on exactly that. The owner's
response set a permanent rule: run the checks yourself before you believe the
report. The orchestrator now verifies an agent's claim before repeating it.

---

## 2. Start with the vision and the specification

Everything in this guide depends on one thing that happens before any code is
written: someone sits down and writes what the product is for and what it must
do. Agents are fast, literal, and confident. Point them at a clear written
requirement and they produce work you can keep. Point them at a vague one and
they will fill the gap with a guess, and you will not find out which guess until
you use the result.

The owner states the chain directly: no vision means a poor specification, and a
poor specification means software you throw away. Each link is worth spelling
out.

A weak vision makes a vague specification, because nobody can say what belongs
in the product and what does not. A vague specification makes agents guess,
because an agent cannot ask you a question at three in the morning. And guessing
agents produce software very quickly — plausible, tidy, tested against its own
assumptions, and wrong. Throwing it away costs more than the time it took to
write, because by then other work sits on top of it.

### The vision document

The **vision** is a short document, a few pages at most, that answers questions
of intent rather than mechanism. It should say:

**Who it is for.** Not "users" but a specific group, named plainly, with what
they already know and what they do not. Every later argument about how much to
explain traces back to this line.

**What problem it solves.** One or two sentences that would still be true if
every technical choice changed.

**The central principle.** One sentence a person can hold in their head, which
settles arguments that the detailed requirements never anticipated. In one
project the sentence was: simplify access to the environment without simplifying
the environment itself. Months later, that one line decided whether a feature
should imitate a real tool in a friendlier form or expose the real tool with an
easier way in. It chose the real tool, every time, without anyone needing to go
back and ask.

**What it will never do.** This is the part people skip, and it is the part that
saves the most work. A written list of non-goals is what lets an agent — or a
reviewer — say "this is out of scope" with evidence instead of instinct. One
project's list ran to fifteen items, and each one was a feature somebody would
otherwise have built.

**The principles that settle later arguments.** A handful of rules stated as
absolutes. Two from one project, both written before any code existed, show how
far a principle reaches. The first: the platform will never change the user's
own version history on their behalf, because a tool that silently saves your
work in your name takes away the thing you were learning to do. Months later
that one line decided the whole design of the recovery feature, which had to let
users undo a bad hour without touching their history. The second: the platform
never records the user's content — not their keys, their instructions to agents,
their source code, or what scrolls past in their terminal. That line decided
what every part of the system could write to a log, and settled a design
question months later with no discussion at all.

### The specification

The **specification** grows out of the vision and is much longer. Where the
vision says why, the specification says what, in enough detail that an agent can
build it. It holds:

**Requirements, in numbered sections.** The numbering is not bureaucracy. It is
the addressing system that makes everything else in this guide work. An
instruction to an agent says "read sections 12.3 and 12.4 before you start," and
the agent reads exactly those and nothing else. That is both cheaper and more
accurate than telling it to read the whole document.

**The security boundaries.** A section listing every place where trust stops,
and what is on each side. This is what the security-reviewing agent is measured
against.

**The list of work, in order.** The epics, each with what it delivers and what
must be true before it counts as done.

**The milestone gates.** The points where the project must stop and prove
something works before going further.

### The technology document

A third document records the technology choices: what was picked, why, and — at
least as valuable — what was rejected and why. Without that last part, every
rejected option gets proposed again by a different agent six weeks later, and
someone reconstructs the argument from memory. With it, the orchestrator answers
in one line and moves on.

### How the three documents settle arguments

The rule is simple and worth stating out loud in your own project: the vision
wins on questions of intent, the specification wins on questions of detail. If
an agent and a reviewer disagree about whether a feature should exist at all,
that is intent, and the vision decides. If they disagree about how it should
behave, that is detail, and the specification decides. Only when neither
document settles it does the question reach the owner, and when it does, the
answer gets written into whichever document should have contained it.

In practice this happens constantly. A builder that thinks a test is wrong must
name the requirement section supporting its reading. A reviewer that wants
something simplified is answered by pointing at the requirement that made it
complicated. Disputes that would otherwise be settled by whoever sounded more
confident become a matter of reading the same paragraph.

### How much time this takes

Honestly: in the project this guide came from, the very first thing saved into
the project was the documents, and nothing else. That first save held a vision
of about 325 lines, a specification of about 2,400, a technology document of
about 1,600, a one-page orientation, and the definitions of five agents — some
4,700 lines, and not one line of the product. Its message said so plainly: "No
application code yet." Code began the same day, but only after all of that
existed. How long the writing took beforehand is not recorded, so this guide
will not invent a number. The ordering is the point.

If that feels like a lot of writing before anything runs, compare it to the
alternative. The specification is read by every agent on every task, forever. It
is the cheapest way to give a hundred separate pieces of work the same
understanding of what you actually want.

---

## 3. Roles

### The owner: decides what is true, and approves the result

You own intent and you own the final approval. You decide what the product
should do and what a user should experience. You settle arguments between agents
when the written requirements do not settle them. And you are the only one who
approves a finished batch of work into the main line of the project.

In practice you answer with short authorizations — "go", "make it so", "merge
it" — and you expect that until you say one of those words, a question you asked
gets answered, not acted on.

You also do the few things the safety system will not let an agent do on its
own: opening a service to the outside network, deleting many things at once, and
using the finished product in a browser like a real user.

### The orchestrator: the conversation you are in

The main conversation is a manager, not a bricklayer. Its job is to understand
the request, write good instructions, start agents, verify their claims, and
report in plain English. It does work itself only for a one-line lookup or a
one-line edit.

The orchestrator holds the plan, the arbitration, and the accumulated
understanding of the project. That understanding is the scarce thing being
protected, which is why the same file is never read into it twice if a cheap
agent can summarize it instead.

### The agent roster

Each agent is defined by a small text file that says which model it runs on, how
hard it should think, who it is pretending to be, what it is allowed to do, and
what its report must contain. Giving each agent a persona turned out to matter.
The owner asked for it: "I notice that the agents don't have any persona (for
example, expert in operations for the infrastructure agent). Does that make a
difference? It seems that it should."

A roster that works looks roughly like this.

**A scout.** Cheap and small, read-only. Its whole job is to find where things
are. It searches the project and reports file names, line numbers, and short
quotes, then names anything it looked for and could not find, so that an absence
is known to be real rather than assumed. Its instructions say: "You locate; you
do not judge." The owner asked for this one by name: "I want a low-cost explorer
agent that can figure out where things are and report those back to smarter,
better agents."

**A builder.** A strong model doing one clearly scoped change at a time. It is
told to build only what the task asks, to prefer the boring solution, to run the
checks that cover its change, and to say plainly when it added something with no
test. It is also told what to do when it disagrees with a reviewer or a test:
say which written requirement supports its reading and why, and let the
orchestrator decide. It must not quietly work around the problem.

**A tester.** A strong model that writes checks based on what the requirements
promise, not on what the code happens to do — otherwise the checks simply agree
with any bug already there. It may not weaken a check to make it pass, and may
not call a check passing unless it ran it and watched it pass.

**A security reviewer.** Read-only, pointed at the places where untrusted input
meets trusted machinery. It works from a written list of **security
boundaries**: the lines where you stop trusting what comes across. It assumes
anything on the far side is hostile — that user code will seize resources, probe
the network, escape its directory, and attack the product's own services. Every
finding must name a file, a line, and a concrete way things go wrong.

**A code reviewer.** Read-only, and looking first for outright mistakes, then
for needless complexity. The owner specified this one himself: correctness and
quality, judged by the old rules of thumb — do not build what nobody needs, keep
it simple, do not repeat yourself, and keep each piece responsible for one
thing. It carries one guard against reviewer noise: if it cannot name a concrete
simpler alternative, it is not allowed to report the complaint at all.

**An infrastructure agent.** For the machines the product runs on, rather than
the product itself. Its persona is an operations engineer "who has run fleets in
production and been paged for the consequences." Because its mistakes are slow
and hard to undo, it states its evidence before any destructive command and
prefers a rehearsal run that changes nothing.

**A merger.** A small, cheap clerk that lands finished work. It waits for the
automated checks, brings a branch up to date when it has fallen behind, combines
the work, and decides whether a failed check is a random **flake** — a check
that sometimes fails without the code changing — a collision with someone else's
change, or a genuine problem. It retries a flake at most twice and escalates
anything needing judgement. It never changes the code. The owner proposed it
after watching the orchestrator do this by hand: "This workflow really begs for
a merge agent. It could escalate to you as the orchestrator only if needed."

### Why cheap agents do most of the work

Most of the work is not hard: finding where something is defined, waiting for a
check to finish, and updating a stale branch need diligence, not insight. Every
token the orchestrator spends reading a file is attention it cannot spend on the
plan, and a scout that reads twenty files and returns thirty lines has turned an
expensive read into a cheap one. And interruptions cost more than they appear
to: the merger agent exists because the orchestrator "was interrupted a dozen
times a day by pure bookkeeping."

One trap is worth knowing in advance: a newly written agent definition usually
only becomes available in conversations started after it exists. The workaround
is to start a general agent on the right model and tell it to read the new
definition file first.

---

## 4. The unit of work

### Words for the machinery

A **repository** is the folder holding all the project's files, together with
its complete history. A **commit** is one saved snapshot of changes, with a
message saying what changed and why. A **branch** is a separate line of work: a
copy of the project where you can make commits without disturbing the main line,
which is conventionally called `main`. To **push** is to send your commits from
your own machine to the shared copy that everyone works from.

A **pull request** is a formal proposal to fold one branch into another. It
shows exactly what changed, collects automated checks and comments, and waits
for approval. To **merge** it is to accept it. A **squash** merge compresses all
the small commits on a branch into one tidy commit on the receiving branch,
which keeps the shared history readable at the cost of losing the step-by-step
detail.

**Continuous integration**, almost always shortened to **CI**, is the robot that
runs every check automatically on every pull request and reports pass or fail. A
**test** is an automated check that some behaviour is correct. A **unit test**
checks one small piece in isolation and runs in milliseconds. An **end-to-end
test** drives the real product the way a person would — clicking buttons in a
real browser — and catches everything the small checks cannot see. **Coverage**
is the percentage of the code that the tests actually exercise.

A **gate** is a point where work stops until a condition is met. Some gates are
automatic, like CI. One gate is always a person: nothing reaches the main line
without the owner's approval.

A **worktree** is a second copy of the repository on disk, checked out to its
own branch, so that two agents can work at the same time without overwriting
each other's files.

### Epics, tasks, and batches

An **epic** is a coherent slice of the product large enough to be worth planning
as a unit — "the file browser and editor", say — with its own written acceptance
criteria. It gets a long-lived branch of its own.

Inside the epic, work is cut into **tasks**: single scoped changes, each with
its own short-lived branch and its own pull request into the epic branch, each
squashed in when its checks go green. When the acceptance criteria are met, the
whole epic branch is proposed to `main` as one pull request, and that one is the
owner's to approve.

A **milestone** is a named point the project must reach — a demonstration, a
first real deployment — with a list of what must be true before it counts.

The rules the hosting service enforces on branches shape the mechanics more than
anyone expects. If every change to a protected branch must arrive by pull
request, even routine housekeeping needs one. If a pull request must be fully up
to date with its target before it can merge, pull requests land strictly one at
a time. Learn these rules early; they will otherwise surprise you at the worst
moment.

### The fix batch

Small problems found in a running product do not each get their own branch and
their own ceremony. The owner's rule: "I really just want to batch up a bunch of
fixes into one epic unless they're showstoppers."

Each small finding becomes a tracked issue under a milestone named something
like "next fix batch", carrying what caused it, a proposed fix, a rough size,
and the requirement sections it touches. When the owner says go, the whole
milestone becomes a small epic: one branch, one pull request per issue, one
review pass, one approval, one deployment. A genuine showstopper — something
that makes the product unusable — skips the queue and gets its own branch
immediately.

The owner is equally clear about what he does not want in between. Offered a
pull request whose only purpose was to write down a note, he said: "We have a
backlog of features. This seems like a small fix. I don't want to open a new
pull request just to create a notes file and merge it. Seems odd."

### How an epic runs, start to finish

Here is one real epic, generically described. It delivered a file browser, a
code editor, a search feature, and a way to review changes. It ran overnight and
is typical in shape.

It began in planning mode, with no changes allowed. The owner asked for a plan,
named the one thing he cared most about, and said how to gather the information:
"Use the explorer agent to read the files you need to plan the epic." The
orchestrator sent scouts to map the existing code, turned their reports into a
plan built from waves of non-overlapping work, and brought the open questions
back for a ruling. The owner ruled on each one.

Then he left, with explicit temporary authority: "After authorizing the plan,
you will cut the branch and I will go away from the keyboard. I expect you to do
your best to work through all the issues, fixing bugs and landing work, so that
when I come back in the morning it will be ready for me to test."

The orchestrator cut the epic branch, started builders in waves, and landed
seventeen task pull requests, each squashed in after its checks passed. Anything
touching a security boundary went through the security reviewer first. When the
last task was in, the security reviewer and the code reviewer ran at the same
time over the whole epic; their findings became further task pull requests; then
both reviewers ran again over the fixed result.

The final gate ran on the owner's own machine with a freshly created database:
every check green, every browser test passing, and a real installable package
produced. Only then did the orchestrator open the one pull request into `main`
and stop. The owner approved it, an infrastructure agent deployed it, and the
automated smoke test on the live machine passed every check.

The owner then used the deployed product as a user would, found twelve problems
in under an hour, and filed them for the next fix batch. One he marked a
showstopper. That last sentence is the important one: every automated gate had
passed.

---

## 5. Instructions that work

An instruction to an agent is a small specification in its own right. A good one
names the requirement sections it must satisfy, the files it is allowed to
touch, the exact starting point in the project's history, what "done" looks
like, and what to leave alone.

**Requirement sections, by number.** Agents read the cited sections before
writing anything. This is what lets a builder push back with evidence instead of
opinion, and what lets the orchestrator settle the argument by reading the same
lines.

**Files in scope, and files out of scope.** Agents working at the same time must
never share a file. Split the work by area. In one project, eight agents ran
simultaneously across nine pull requests with no collisions, because the split
was drawn along clean lines and the one file two of them would have touched was
assigned explicitly to one of them.

**The exact starting point.** A new worktree usually starts from the main line,
not from the branch the orchestrator happens to be on. In one project both
builders on a task silently started from the wrong point and had to be reset by
hand. The rule that came out of it: always tell an agent the exact commit to
start from.

**What done looks like.** Which checks must pass, which commands must be run,
and what the report must contain. Require the actual output of the command, not
a sentence claiming it passed, because a claim was wrong once and cost a failed
run.

**A preamble of non-negotiables.** Each agent definition opens with its persona
and a short list of things never up for debate, before any task detail. For an
infrastructure agent that might be: everything reproducible from source control,
user data on separate storage, management networks unreachable from user code.
The task instruction adds only what is specific to the job.

**Private databases and ports.** Agents running at the same time collide on
shared resources in ways that look exactly like real bugs. If several tests
share one database, they must not run at the same time. Each agent should create
its own database rather than share one. Browser tests are worse, because they
usually claim fixed network ports, so two browser runs on one machine fight each
other. Run browser-test agents one at a time, or accept that some will need a
rerun.

**Time boxes.** A debugging agent without a limit will burn an afternoon. One
spent thirty minutes repeatedly rerunning a fifteen-minute test instead of
reproducing the single failing request. The rule: give debugging agents a tight
recipe for reproducing the problem and a hard time limit, and check on them
after ten minutes. Write the limits into the agent's own definition where you
can.

**Report a sentence; do not edit a shared document.** Early on, every pull
request collided in the status document, because each builder appended to the
same paragraph. The fix: builders report their status sentence in the pull
request description, and the orchestrator writes them all into the document
once, at the end.

### What a prompt actually looks like

A short example, to make it concrete. This is the shape, not the content:

```
Read requirement sections 12.3 and 12.4 before you start.
Work only in the file-list component and its tests.
Do not touch the editor or anything under the server folder.
Start from commit a1b2c3d.
Done means: the list shows folders before files, sorted by name;
a new unit test covers the sort order; the existing checks still pass.
Report the actual output of the test command, not a summary.
```

Five short instructions, and nothing left to interpretation.

---

## 6. Saving money and time

**Send the cheapest agent that can do the job.** Scout before builder, always,
when you do not know where something lives. The standing rule: run the scout
first when a location is unknown and pass its file paths on, rather than making
an expensive agent search.

**Run agents in parallel, split by boundary.** In one project seven builders ran
from a single plan with only two collisions, both trivial. The template that
works is waves: one agent alone on the shared foundations first, then many in
parallel on separate areas, then testers and reviewers in parallel, then a few
fix agents split by file ownership.

**Know when not to parallelize.** In one plan, wave one was nine parallel tasks
on separate files and wave two was five tasks that all had to pass through a
single file, run strictly one after another. Forcing the second wave to run
together would have produced collisions costing more than the time saved.

**Hand bookkeeping to a clerk.** Waiting for checks, updating stale branches,
and retrying random failures are mechanical. Give them to the cheapest agent
that can be trusted with them.

**Never wait by sleeping in a loop.** A background wait that watches for a
process matching some pattern can deadlock, because the waiting command's own
text matches the pattern and it waits for itself forever. Worse, stopping the
pattern then stops the replacement too. Instead, poll the actual status of the
thing you are waiting for, or use a proper completion notification.

**Keep the automated checks fast.** The owner: "do it. I always want the
automated checks to be as fast as possible." Caching downloads cut one four-
minute step to seconds. Installing a minimal browser instead of a full one cut
another. Any step over a minute is a candidate to cache or remove, and reports
should mention how long the checks took.

**Accept some contention rather than serializing everything.** Heavy jobs
running alongside test suites once starved the owner's own machine. Offered the
choice, he said: "No, it's okay. I'll live with the contention." The rule: warn
him when a heavy job starts, so a slow machine is not mistaken for a bug.

---

## 7. The gates that replace line-by-line human reading

The owner reads one pull request per epic. Everything in this section is what
makes that safe.

**Tests are part of done, not a follow-up.** A change ships with unit tests for
its logic, and anything a person can see on screen ships with browser tests too.
Write the test first when the behaviour is clear enough to state. A bug fix
starts with a test that fails for exactly the reported reason.

**Browser tests are not optional.** This became a rule after a visible feature
landed without one. In one project a plain sign-out button returned an error in
a real browser, because the helper the small tests used sent data in a different
format than a browser does. No unit test could have caught it; the browser test
caught it at once.

**A coverage floor.** The automated checks fail if coverage drops below a set
percentage. The rule attached to the number matters more than the number: nobody
may lower the floor to make a run pass. If a change genuinely cannot meet it,
say so and let the owner decide.

**Security review at every boundary.** Anything touching sign-in, the gateway
that serves user content, the component that runs user code, file handling, or
container isolation goes through the security reviewer before it is called done.
Across three epics in one project this found unbounded reads a user could turn
into a memory-exhaustion attack, a write that followed a broken shortcut out of
its own directory, a limit the underlying search tool silently ignores, a
conversion where the text "false" was treated as true, internal error text
relayed to the browser word for word, and a message size limit set a hundred
times too high. None were visible in a functional test.

**One code review over the whole epic.** Run once, over everything, before the
final pull request. It catches the seams that appear only after parallel work
lands together: a leftover polling loop nobody removed, one abbreviation meaning
two different things in two files, a watcher that failed silently while other
parts depended on it, and a shutdown handler that would have hung every restart
for ninety seconds.

**A confirmation review.** After the review findings are fixed, both reviewers
run again over the result. Fixes made in a hurry are still fixes made in a
hurry.

**The full battery locally, on a fresh database.** Before the epic's pull
request, run everything on a real machine with a database created from nothing
for that run. The freshness is not ceremony. One browser test once passed
locally only because an unrelated earlier test had left a row behind in a shared
database; the automated checks, which start clean, failed.

**Real-machine verification for infrastructure.** Automated checks can only
inspect infrastructure descriptions; they cannot prove a machine will actually
come up. One early change passed every check and then failed at every single
step of the first real run: initialization, provider versions, boot
configuration, disk permissions, data processing, keys, and the final smoke
test. Since then, anything touching infrastructure runs its whole lifecycle on a real
machine before its pull request is called ready: build from nothing, configure,
configure again and confirm the second run changes nothing, run the smoke test,
and boot a throwaway machine from scratch, reported step by step.

**Adversarial probes.** The first time a tester agent ran, it deliberately
planted a fake password, a type error, and an unused variable to see whether the
checks would notice. They found a real defect: the style checker was reporting
success despite its own warnings. Those probes stayed in the tester's standing
instructions.

**Run it again.** The owner's summary of why all of this exists: "Every time
we've run tests, we've found something. Let's run the battery again." And before
a major approval: "tear down the machine and run the battery one more time
before we merge."

---

## 8. The owner's working rules, in his words

These come from the owner's standing instructions and from what he has said
during sessions. They are short because they are meant to be remembered.

**Done means done.** "Not half done. Not done except for the part I decided to
skip. And not a report about how it will be done. N things asked means N things
delivered, however long they take. If one is genuinely blocked, finish the rest
and name the specific blocker in one sentence — not 'this needs more
investigation.'"

**Act, don't ask.** Work that is cheap and reversible gets done and then
reported: research, analysis, drafts, tidying inside the scope already given. "A
question costs me more than a re-run costs you." Ask first only for something
that reaches an audience, something that cannot be undone, or something
expensive. Something broken gets fixed, not reported: "reporting an issue I
could have had fixed turns your work into my to-do list."

**A question is a question.** "'Should we use X?' is not 'migrate to X.' 'What
would it take to add Y?' is not 'add Y.' When in doubt, assume it's a question.
Answer first; act when I say go." He uses this constantly, and usually says so
outright: "Don't change anything, but let me know your thoughts," or "Don't do
that right now, but tell me what that would entail."

**Build only what was asked.** No settings, no layers of abstraction, and no
extension points for needs nobody has today. "If a future need is real, say so
in one sentence and still leave it unbuilt."

**Prefer boring.** "Longer and obvious beats short and clever. Fewer moving
parts, fewer layers, fewer new files." Remove duplication that is real, and
leave alone things that merely look alike, because merging two things too early
is harder to undo than keeping a copy. Use what is already in the project before
adding anything new, and say out loud why if you add one.

**Recommend, do not survey.** "Recommend the simplest thing that solves the
problem actually in front of you, and say which option you would pick rather
than listing them all." He also expects to be argued with, and he changes his
mind: he has asked to be challenged and has reversed decisions when given a real
argument.

**Approval is his gate.** Task pull requests inside an epic can land
automatically once their checks are green. The one pull request that reaches the
main line is his. He grants authority beyond that explicitly and temporarily —
"I'm going away from the keyboard, so do your best to resolve issues on your
own. You have my authority to merge all pull requests for the remainder of this
session" — and it does not carry over to the next session.

**How he corrects drift.** He does not soften it, and he asks for the cause
rather than an apology. "It seems like you were stuck. Plus, you, the expensive
orchestrator, are doing too much work that should be delegated to a cheaper
subagent. What is going on?" "Is the infrastructure agent stuck? It's been
waiting a while." "I think the merge agent is stuck polling something that is
already green." "You've set one agent to a cheap model. Is that right?" Each of
those questions produced a permanent change: delegation of verification runs, a
dedicated merge agent, an escalation rule.

---

## 9. Lessons learned the hard way

Each of these cost real time, and each produced a rule now written somewhere an
agent will read it.

**Squashed history breaks replays, so apply the difference instead.** Agents
work in separate copies started from an older point, and often pull the shared
branch in as they go. Once the shared branch has squashed their siblings' work
into single commits, the usual technique of replaying an agent's commits on top
collides on every file the squash already contains, because the same changes now
appear twice with different histories. What happened: three separate agents'
work stalled for the better part of an hour each. The rule: take the plain
difference between where the agent started and where it ended, apply that
difference to the current shared branch, and commit it once. Do not replay the
history.

**Branches cut early go stale fast.** Reviewers pointed at a branch created
before three sibling changes landed were reviewing a version of the project
missing four completed changes entirely, so the whole review was wasted. The
rule: before starting a reviewer or approving anything, confirm the branch
actually contains the current state, and say which changes it holds.

**Phantom merges.** A loop that printed "merged" without checking whether the
command had succeeded reported four merges that never happened, and an hour went
into building on a state that did not exist. The rule: never report something as
merged unless a separate query confirms it, and check first whether the branch
is behind, blocked, or in conflict.

**Deleting a target branch closes its pull requests.** Hosting services close a
pull request when the branch it aims at disappears; in one project this silently
closed several at once. The rule: every task pull request aims at the epic
branch, never at another pull request's branch, and a branch other work depends
on is never deleted when it merges.

**Shared test resources masquerade as bugs.** Agents running at once shared
fixed network ports and one test database. Two browser runs together produced
failures that looked exactly like real application bugs, and an hour went into
chasing one that did not exist. The rule: every agent gets its own database, and
browser-running agents run one at a time or accept a rerun.

**An automated test destroyed live work.** A smoke test aimed at the live
deployment cleaned up after itself by deleting everything belonging to its test
users. The owner happened to be signed in as one of them, and his running work
and its storage were destroyed. The test was fixed to delete only what that run
created, but the rule stands independently: never run a destructive test against
a machine someone is using, and ask before running one against a live deployment
at all.

**The safety system has sharp edges.** The permission layer that stops agents
doing dangerous things is pattern-based, and patterns misfire. It blocked a
legitimate approval as if it were an attempt to skip review. It blocks disabling
a security-related test even temporarily, so the answer is to fold the dependent
fix into the same change. It blocks opening a local service to the network, so
that step was written as a script for the owner to run. And in one memorable
case it blocked every command that mentioned version control twice, so a branch
whose own name contained that word trapped every agent that touched it and cost
half a morning. The rule: keep tool names out of branch names, and when the
safety system blocks something legitimate, hand that one step to the owner
rather than fighting it.

**Agent claims that were wrong.** A builder reported that the style check
passed; the shared automated check failed on it. An infrastructure agent
reported that a temporary storage pool had been removed; a later agent found it
still there and built on a false assumption. Both produced the same rule: verify
before relaying. Run the checks yourself in the agent's own copy, require the
command's actual output in the report rather than a claim about it, and confirm
any change of state with the tool that owns that state.

**The false conflict warning.** In one epic the editor warned "this file changed
on disk while you were editing it" the moment anyone typed, and again after
every automatic save, when nothing but the editor itself had touched the file.
The owner found it within a minute of real use and added what he wanted instead:
if something really does change the file, show the two versions side by side. It
became a showstopper and jumped the queue. The lesson is about the limits of
every other gate: all tests passed, both reviewers were clean, and the bug was
obvious in sixty seconds of real typing. Hands-on use of the deployed product is
a gate, not a courtesy.

**Orphaned load generators.** A debugging agent investigating a slow search
started sixteen endless loops to simulate a busy machine, then tried to stop them
with a shell feature that does not exist in a non-interactive script. They ran at
full processor for five hours until the owner noticed. The rule: never create
background load with detached loops; if load is needed, record the process
numbers and kill them from a cleanup routine that runs however the script ends.
Check for stray processes after any agent session.

**A safety relaxation must be written down.** Automatic merging of task work
only became possible by granting agents permission to run the merge command
themselves — a real loosening of a real guard. The decision record says so
plainly: the cost is that a bad change can reach the epic branch before any
human has seen it, and the epic-level review plus the full local battery are
what compensate. Any workaround that buys speed by relaxing a safety rule gets
written down where the next reader will find it, with what now makes up for it.

**Clean up after every merge.** Fifty-two stale agent branches and nine
abandoned working copies accumulated across several epics before anyone noticed,
consuming disk and confusing later agents about which branch was current. The
owner: "We need to always clean up branches and working copies after a merge."
It is now part of the merge step, not a later chore.

---

## 10. What to take away

A one-page distillation.

**Spend the time on the vision and the specification first.** Everything flows
from those two documents. No vision gives you a vague specification; a vague
specification makes agents guess; and guessing agents produce a great deal of
software that has to be thrown away. Write who it is for, what problem it
solves, what it will never do, and the handful of principles that will settle
arguments nobody has had yet. Then write the requirements out in numbered
sections.

**Write the requirements down before you write the instruction.** A numbered
specification is what lets a cheap agent do good work, lets two agents settle an
argument with evidence, and lets a reviewer tell over-engineering from a genuine
requirement. The vision wins on questions of intent; the specification wins on
questions of detail; only what neither settles reaches you.

**Be the orchestrator, not the typist.** Decide what is true, split the work so
the pieces cannot collide, write instructions that name the requirement
sections, the files, the starting point and the definition of done, and check
what comes back. If you find yourself reading files in order to write code, you
have taken someone else's job.

**Send the cheapest agent that can do the job.** A search is a search. A merge
is a merge. Save expensive reasoning for planning, for settling arguments, and
for decisions nobody has made yet.

**Parallelize by boundary, never by hope.** Two agents must never be able to
touch the same file, database, or network port. When several changes must pass
through one file, run them one after another and say so in the plan.

**Replace human reading with machine checking.** Tests written from the
requirements rather than from the code, a coverage floor nobody may lower to
pass, browser tests for anything a person can see, a security reviewer with a
real threat model, a code reviewer with a mandate for simplicity, and a full run
of everything on a fresh database. Then one human review, spent where a human is
actually worth it.

**Trust no report you have not verified.** Run the check yourself. Query the
state. Confirm the thing is really gone. This is not about dishonesty; it is the
difference between believing a command succeeded and having watched it succeed.

**Nothing is done until a person has used it.** Every automated gate passed on
the false conflict warning, and sixty seconds of real typing found it. Deploy to
something real, use it the way your users will, and treat what you find as
information about your gates as much as about your code.

**Write down every lesson where an agent will read it.** A lesson learned and
not written into the next instruction will be learned again, at full price.

**Ask a question as a question.** And when you are the one answering, answer it.

---

## Appendix: where this came from

This guide grew out of building one real product over several months, entirely
by directing AI agents. One person owned the intent, wrote the requirements,
ruled on disputes, and approved every release. He did not write the code. The
arrangement produced a working, deployed product used by real people, along with
a great many of the mistakes recorded above. The specific product does not
matter; the method transfers.

---

## Glossary

**ADR (architecture decision record)** — A short numbered document recording one
significant technical decision, the alternatives considered, and the reasoning,
written when the decision is made.

**Agent** — An AI assistant given a job, a set of tools, and permission to use
them independently: reading files, changing them, running programs, and
reporting back.

**Branch** — A separate line of work in a repository, where changes can be made
without disturbing the main line.

**Commit** — One saved snapshot of changes, with a message explaining what
changed and why.

**Continuous integration (CI)** — The automated system that runs every check on
every proposed change and reports pass or fail.

**Coverage** — The percentage of a project's code that its tests actually
exercise.

**Debounce** — To wait for a short quiet period before acting on rapid repeated
events, so that many keystrokes produce one save rather than fifty.

**End-to-end test** — An automated check that drives the whole product the way a
person would, usually in a real browser.

**Epic** — A coherent slice of the product large enough to plan as a unit, with
its own branch and its own acceptance criteria.

**Flake** — A test that sometimes passes and sometimes fails without the code
changing, usually because of timing or a shared resource.

**Gate** — A point where work stops until a condition is met, such as all checks
passing or the owner approving.

**Merge** — To fold one branch's changes into another, accepting them.

**Milestone** — A named point the project must reach, with a list of what must
be true before it counts.

**Model** — The particular AI doing the thinking. Larger models reason better
and cost more; smaller ones are cheaper and faster.

**Non-goal** — Something written down as deliberately out of scope, so that it
can be ruled out later with evidence rather than instinct.

**Orchestrator** — The single conversation the owner has, which plans, delegates
to other agents, verifies their work, and reports in plain language. It does not
write the software itself.

**Pull request** — A formal proposal to merge one branch into another, showing
what changed and collecting automated checks and comments before approval.

**Push** — To send commits from your own machine to the shared copy of the
repository.

**Repository** — The folder holding all of a project's files together with its
complete history.

**Review** — A careful read of a proposed change looking for mistakes, risks, or
needless complexity, done here by dedicated agents and finally by the owner.

**Security boundary** — A line in the system where you stop trusting what comes
across it, such as between user-supplied code and the product's own services.

**Specification** — The written description of what the product must do,
organized into numbered sections so instructions can point at exact ones.

**Squash** — To compress all the commits on a branch into one commit when
merging, keeping the shared history readable.

**Test** — An automated check that some behaviour is correct.

**Token** — Roughly a chunk of a word. AI work is measured and billed in tokens,
counting everything the model reads and everything it writes.

**Unit test** — An automated check of one small piece of the code in isolation,
running in milliseconds.

**Vision** — The short document stating who the product is for, what problem it
solves, what it will never do, and the principles that settle later arguments.

**Worktree** — A second copy of a repository on disk, checked out to its own
branch, so two agents can work at once without overwriting each other.
