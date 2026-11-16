/**
 * The paid model check (SPEC.md section 20.5, "Tested models"): the scripted
 * tasks in tasks.ts, run through the real assistant on the pilot with one
 * OpenAI model and one Claude model, reported pass or fail per task. It runs
 * only with the owner's go-ahead; `--dry-run` runs the same harness against
 * the end-to-end stack's fake model for free (scripts/model-check/dry-run).
 *
 *   tsx scripts/model-check/run.ts [--provider openai|anthropic|both] [--task <id>] [--dry-run]
 *
 * Environment:
 *   MODEL_CHECK_URL                 the site (default: the pilot)
 *   MODEL_CHECK_SIGNIN_FILE         mode 0600: an administrator's email, password and,
 *                                   if it has one, TOTP secret, one per line
 *                                   (default: PORTIKUS_SMOKE_SIGNIN_FILE)
 *   MODEL_CHECK_OPENAI_KEY_FILE     mode 0600 files holding one key each, read only
 *   MODEL_CHECK_ANTHROPIC_KEY_FILE  when that key is saved, and never logged
 *   MODEL_CHECK_SSH                 ssh destination of the site's VM, for the course fixture
 *   MODEL_CHECK_WORKSPACE_ID        a workspace the Diagnose task may read
 *   MODEL_CHECK_FAKE_MODEL_URL, TEST_DATABASE_URL   the dry run's fake model and database
 *
 * Results go to scripts/model-check/results/: task ids, pass or fail, short
 * reasons made by this script, and token counts. Never a prompt's answer,
 * the model's words or a key.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AI_NOTICE_VERSION } from "../../packages/contracts/src/ai.ts";
import { callFact, type Facts, judge } from "./check.ts";
import {
	clearGates,
	Fixtures,
	localSql,
	type Made,
	sshSql,
	Unavailable,
} from "./fixtures.ts";
import {
	Conversation,
	dexSignIn,
	mockSignIn,
	type Session,
	type WireEvent,
} from "./site.ts";
import { type CardAction, TASKS, type Task } from "./tasks.ts";

const PILOT_URL = "https://pilot.portikus.thewhittakers.org:8443";
const RESULTS_DIR = join(import.meta.dirname, "results");
/** Answers to cards past the task's own list; enough for any sane task. */
const MAX_CARDS = 6;

type ProviderName = "openai" | "anthropic";

const PROVIDERS: Record<
	ProviderName,
	{
		kind: "openai-compatible" | "anthropic";
		baseUrl: string;
		model: string;
		keyEnv: string;
	}
> = {
	openai: {
		kind: "openai-compatible",
		baseUrl: "https://api.openai.com/v1",
		model: "gpt-6-luna",
		keyEnv: "MODEL_CHECK_OPENAI_KEY_FILE",
	},
	anthropic: {
		kind: "anthropic",
		baseUrl: "https://api.anthropic.com",
		model: "claude-haiku-5-5",
		keyEnv: "MODEL_CHECK_ANTHROPIC_KEY_FILE",
	},
};

type AiView = {
	enabled: boolean;
	providerKind: "openai-compatible" | "anthropic";
	baseUrl: string | null;
	model: string | null;
	monthlyTokenCap: number;
	conversationTokenBudget: number;
	noticeVersion: number | null;
	hostListed: boolean;
};

type Counts = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
};

type TaskResult = {
	id: string;
	role: Task["role"];
	result: "pass" | "fail" | "skipped";
	reason: string;
	tokens: number;
};

type ProviderResult = {
	provider: ProviderName;
	model: string;
	test: { ok: boolean; stage: string | null; errorCode: string | null };
	tasks: TaskResult[];
	usage: Counts | null;
	/** Input-side dollars from the site's price table; null with no row. Output tokens have no price there. */
	estimatedInputCostUsd: number | null;
};

const { values: args } = parseArgs({
	options: {
		provider: { type: "string", default: "both" },
		task: { type: "string" },
		"dry-run": { type: "boolean", default: false },
	},
});
const dryRun = args["dry-run"] === true;
const providers: ProviderName[] =
	args.provider === "both" ? ["openai", "anthropic"] : [args.provider as ProviderName];
if (!providers.every((p) => p in PROVIDERS))
	fail("--provider is openai, anthropic or both");
const tasks = args.task ? TASKS.filter((t) => t.id === args.task) : TASKS;
if (tasks.length === 0) fail(`no task is called ${args.task}`);

function fail(message: string): never {
	console.error(`model-check: ${message}`);
	process.exit(2);
}

function env(name: string): string | undefined {
	const value = process.env[name];
	return value === undefined || value === "" ? undefined : value;
}

/** A secret file's lines; it must be readable by its owner alone, as the smoke test's is. */
function secretLines(path: string): string[] {
	if ((statSync(path).mode & 0o077) !== 0) fail(`${path} must have mode 0600`);
	return readFileSync(path, "utf8")
		.split("\n")
		.map((line) => line.trim());
}

function readKey(provider: ProviderName): string {
	if (dryRun) return "sk-model-check-dry-run";
	const path = env(PROVIDERS[provider].keyEnv);
	if (!path) fail(`set ${PROVIDERS[provider].keyEnv}`);
	const [key] = secretLines(path);
	if (!key) fail(`${PROVIDERS[provider].keyEnv} names an empty file`);
	return key;
}

const base =
	env("MODEL_CHECK_URL") ??
	(dryRun ? fail("the dry run needs MODEL_CHECK_URL") : PILOT_URL);
const fakeModel = dryRun
	? (env("MODEL_CHECK_FAKE_MODEL_URL") ?? fail("set MODEL_CHECK_FAKE_MODEL_URL"))
	: null;
const run = randomBytes(3).toString("hex");

async function signInAdmin(): Promise<Session> {
	// carol is the end-to-end stack's administrator (e2e/helpers.ts openAdmin).
	if (dryRun) return mockSignIn(base, "carol");
	const path = env("MODEL_CHECK_SIGNIN_FILE") ?? env("PORTIKUS_SMOKE_SIGNIN_FILE");
	if (!path) fail("set MODEL_CHECK_SIGNIN_FILE");
	const [email, password, totpSecret] = secretLines(path);
	if (!email || !password)
		fail(`${path} must hold an email and a password on two lines`);
	const session = await dexSignIn(base, email, password);
	await clearGates(session, { password, totpSecret: totpSecret || null });
	return session;
}

/** Teach the fake model a script (dry run only), as e2e/assistant-helpers.ts does. */
async function script(match: string, steps: unknown[]): Promise<void> {
	if (!fakeModel) return;
	const response = await fetch(`${fakeModel}/__script`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ match, steps }),
	});
	if (!response.ok)
		throw new Error(`the fake model refused a script: ${response.status}`);
}

function fill(text: string, vars: Record<string, string>): string {
	return text.replace(
		/\{([a-z0-9.]+)\}/gi,
		(whole, name: string) => vars[name] ?? whole,
	);
}

function fillDeep(value: unknown, vars: Record<string, string>): unknown {
	return JSON.parse(fill(JSON.stringify(value), vars));
}

async function latestAuditId(admin: Session): Promise<number> {
	const page = await admin.json<{ events: { id: number }[] }>(
		"GET",
		"/admin/audit?action=assistant.used",
	);
	return page.events[0]?.id ?? 0;
}

/** The person's `assistant.used` rows newer than `since`, newest first. */
async function auditSince(
	admin: Session,
	userId: string,
	since: number,
): Promise<Facts["audit"]> {
	const rows: Facts["audit"] = [];
	let before: number | null = null;
	for (;;) {
		const page: {
			events: {
				id: number;
				actor: string;
				result: string;
				metadata: { operation?: unknown } | null;
			}[];
			nextBefore: number | null;
		} = await admin.json(
			"GET",
			`/admin/audit?action=assistant.used${before ? `&before=${before}` : ""}`,
		);
		for (const event of page.events) {
			if (event.id <= since) return rows;
			const operation = event.metadata?.operation;
			if (event.actor === `user:${userId}` && typeof operation === "string") {
				rows.push({ operation, result: event.result });
			}
		}
		if (page.nextBefore === null) return rows;
		before = page.nextBefore;
	}
}

function factsFrom(events: WireEvent[]): Pick<Facts, "calls" | "cards" | "replyText"> {
	const finished = new Map<string, boolean>();
	for (const event of events) {
		if (event.type === "tool.finished" && event.id)
			finished.set(event.id, event.isError === true);
	}
	const calls = events
		.filter((e) => e.type === "tool.started")
		.map((e) =>
			callFact(
				{ name: e.name ?? "", input: e.input },
				finished.get(e.id ?? "") ?? null,
			),
		);
	const cards = events
		.filter((e) => e.type === "permission.requested")
		.map((e) => {
			const batch =
				e.toolName === "run_batch"
					? (e.input as { operation?: string; rows?: unknown[] })
					: null;
			return {
				name: e.toolName ?? "",
				batchOperation: batch?.operation ?? null,
				rows: batch?.rows?.length ?? null,
			};
		});
	const replyText = events
		.filter((e) => e.type === "message" && e.role === "assistant")
		.map((e) => e.markdown ?? "")
		.join("\n");
	return { calls, cards, replyText };
}

function answerFor(action: CardAction, card: WireEvent): unknown {
	const frame = { type: "permission.answer", id: card.id };
	if (action === "deny") return { ...frame, optionId: "deny" };
	if (action === "approve") return { ...frame, optionId: "approve" };
	const right = card.confirmText ?? "";
	return {
		...frame,
		optionId: "approve",
		confirmation: action === "confirm-right" ? right : `${right}-not-this`,
	};
}

/** Wait out a turn, then answer each card it left as the task says, until none is open. */
async function playTurn(
	conversation: Conversation,
	actions: CardAction[],
	answered: { n: number },
) {
	await conversation.settled();
	for (;;) {
		const card = conversation.openCards()[0];
		if (!card) return;
		if (answered.n >= MAX_CARDS) throw new Error("too many cards");
		conversation.send(answerFor(actions[answered.n] ?? "deny", card));
		answered.n += 1;
		await conversation.settled();
	}
}

type Context = {
	admin: Session;
	adminId: string;
	instructor: () => Promise<{ session: Session; id: string }>;
	fixtures: Fixtures;
	provider: ProviderName;
};

function taskVars(made: Made, tag: string): Record<string, string> {
	const vars: Record<string, string> = { tag };
	if (made.target) {
		vars["target.id"] = made.target.id;
		vars["target.name"] = made.target.name;
		vars["target.email"] = made.target.email;
	}
	if (made.courseId) vars["course.id"] = made.courseId;
	if (made.workspaceId) vars["workspace.id"] = made.workspaceId;
	for (const n of [1, 2, 3, 4, 5]) {
		vars[`invite${n}`] = `modelcheck-${tag}-${n}@example.invalid`;
	}
	return vars;
}

/** The new conversation's body, and the first message the fake model will see in it. */
function opening(task: Task, made: Made, tag: string): { body: object; first: string } {
	if (task.diagnose === "health") {
		return {
			body: { context: { kind: "health" } },
			first: "Diagnose the site's health",
		};
	}
	if (task.diagnose === "workspace") {
		return {
			body: { context: { kind: "workspace", id: made.workspaceId } },
			first: `Diagnose workspace ${made.workspaceId?.slice(0, 8)}`,
		};
	}
	return {
		body: task.inCourse ? { courseId: made.courseId } : {},
		first: `model-check ${tag}]`,
	};
}

/** Send the task's messages and answer its cards; the socket's events when it is done. */
async function play(
	task: Task,
	session: Session,
	conversationId: string,
	vars: Record<string, string>,
	tag: string,
	first: string,
): Promise<WireEvent[]> {
	await script(first, fillDeep(task.fake, vars) as unknown[]);
	if (task.followUp) {
		await script(
			`${tag} follow-up]`,
			fillDeep(task.fakeFollowUp ?? [], vars) as unknown[],
		);
	}
	// The dry run marks each message so the fake model picks this task's script.
	const marker = dryRun ? ` [model-check ${tag}]` : "";
	const followMarker = dryRun ? ` [model-check ${tag} follow-up]` : "";
	const conversation = await Conversation.open(session, conversationId);
	try {
		const answered = { n: 0 };
		const cards = task.cards ?? [];
		if (task.prompt) {
			const text = fill(task.prompt, vars) + marker;
			conversation.send({ type: "send", text, attachments: [] });
		}
		await playTurn(conversation, cards, answered);
		if (task.followUp) {
			const text = fill(task.followUp, vars) + followMarker;
			conversation.send({ type: "send", text, attachments: [] });
			await playTurn(conversation, cards, answered);
		}
		return conversation.events;
	} finally {
		conversation.close();
	}
}

/** The target account and this task's open invitations, as the site holds them now. */
async function stateFacts(
	admin: Session,
	made: Made,
	tag: string,
): Promise<Pick<Facts, "target" | "invitations">> {
	let target: Facts["target"] = null;
	if (made.target) {
		const found = await admin.json<{
			users: { id: string; disabledAt: string | null; role: string }[];
		}>("GET", `/admin/users?q=${encodeURIComponent(made.target.email)}`);
		const user = found.users.find((u) => u.id === made.target?.id);
		if (user) target = { disabled: user.disabledAt !== null, role: user.role };
	}
	const open = await admin.json<{ invitations: { email: string }[] }>(
		"GET",
		"/admin/invitations",
	);
	const invitations = open.invitations.filter((i) =>
		i.email.startsWith(`modelcheck-${tag}-`),
	).length;
	return { target, invitations };
}

async function runTask(task: Task, index: number, ctx: Context): Promise<TaskResult> {
	const out = (
		result: TaskResult["result"],
		reason: string,
		tokens = 0,
	): TaskResult => ({
		id: task.id,
		role: task.role,
		result,
		reason,
		tokens,
	});
	const tag = `${ctx.fixtures.run}-${ctx.provider[0]}${index}`;
	let person: { session: Session; id: string };
	let made: Made;
	try {
		person =
			task.role === "admin"
				? { session: ctx.admin, id: ctx.adminId }
				: await ctx.instructor();
		made = await ctx.fixtures.make(task.needs ?? [], tag);
	} catch (error) {
		if (error instanceof Unavailable) return out("skipped", error.message);
		throw error;
	}
	const vars = taskVars(made, tag);
	const since = await latestAuditId(ctx.admin);
	const { body, first } = opening(task, made, tag);
	const summary = await person.session.json<{ id: string }>(
		"POST",
		"/assistant/conversations",
		body,
	);
	let events: WireEvent[] | null = null;
	let failure: string | null = null;
	try {
		events = await play(task, person.session, summary.id, vars, tag, first);
	} catch (error) {
		failure = error instanceof Error ? error.message : "the task failed";
	}
	const listed = await person.session.json<{
		conversations: { id: string; tokensUsed: number }[];
	}>("GET", "/assistant/conversations");
	const tokens = listed.conversations.find((c) => c.id === summary.id)?.tokensUsed ?? 0;
	await person.session.json("DELETE", `/assistant/conversations/${summary.id}`);
	if (failure !== null || events === null) return out("fail", failure ?? "", tokens);

	const facts: Facts = {
		...factsFrom(events),
		audit: await auditSince(ctx.admin, person.id, since),
		...(await stateFacts(ctx.admin, made, tag)),
	};
	const reason = judge(task.expect, facts);
	return reason === null ? out("pass", "", tokens) : out("fail", reason, tokens);
}

/** One model's tokens over the last week, summed over everyone, for a before-and-after difference. */
async function usageOf(admin: Session, model: string): Promise<Counts> {
	const usage = await admin.json<{ users: (Counts & { model: string })[] }>(
		"GET",
		"/admin/ai-usage?days=7",
	);
	const sum: Counts = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};
	for (const row of usage.users.filter((r) => r.model === model)) {
		sum.inputTokens += row.inputTokens;
		sum.outputTokens += row.outputTokens;
		sum.cacheReadTokens += row.cacheReadTokens;
		sum.cacheWriteTokens += row.cacheWriteTokens;
	}
	return sum;
}

/** Input-side dollars by the site's price table, whose rows match as a substring of the model id. */
async function inputCost(
	admin: Session,
	provider: ProviderName,
	model: string,
	used: Counts,
) {
	const table = await admin.json<{
		prices: {
			provider: string;
			model: string;
			inputPricePerMillion: number;
			cacheReadRatio: number;
			cacheWriteRatio: number;
		}[];
	}>("GET", "/admin/pricing");
	const row = table.prices
		.filter((p) => p.provider === provider && model.includes(p.model))
		.sort((a, b) => b.model.length - a.model.length)[0];
	if (!row) return null;
	const perToken = row.inputPricePerMillion / 1_000_000;
	return (
		perToken *
		(used.inputTokens +
			used.cacheReadTokens * row.cacheReadRatio +
			used.cacheWriteTokens * row.cacheWriteRatio)
	);
}

async function saveProvider(admin: Session, provider: ProviderName): Promise<void> {
	const chosen = PROVIDERS[provider];
	// The fake model speaks only Chat Completions, so the dry run sends both through it that way.
	await admin.json("PUT", "/admin/ai", {
		providerKind: dryRun ? "openai-compatible" : chosen.kind,
		baseUrl: chosen.baseUrl,
		model: chosen.model,
		key: readKey(provider),
		...(dryRun ? {} : { addProxyHost: true }),
	});
	if (!dryRun) {
		// The proxy host is added by a site job; the Test needs it in place.
		for (let wait = 0; ; wait++) {
			const view = await admin.json<AiView>("GET", "/admin/ai");
			if (view.hostListed) break;
			if (wait >= 60)
				throw new Error(`the proxy never listed ${new URL(chosen.baseUrl).host}`);
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
	}
	await admin.json("PUT", "/admin/ai", { enabled: true });
}

async function runProvider(
	provider: ProviderName,
	ctx: Omit<Context, "provider">,
): Promise<ProviderResult> {
	const { model } = PROVIDERS[provider];
	await saveProvider(ctx.admin, provider);
	await script("portikus_ping check", [
		{ toolCalls: [{ name: "portikus_ping", arguments: { word: "pong" } }] },
		{ text: "pong" },
	]);
	const before = await usageOf(ctx.admin, model);
	const test = await ctx.admin.json<{
		ok: boolean;
		stage: string | null;
		errorCode: string | null;
	}>("POST", "/admin/ai/test");
	const result: ProviderResult = {
		provider,
		model,
		test: { ok: test.ok, stage: test.stage, errorCode: test.errorCode },
		tasks: [],
		usage: null,
		estimatedInputCostUsd: null,
	};
	if (test.ok) {
		for (const [index, task] of tasks.entries()) {
			const one = await runTask(task, index, { ...ctx, provider });
			console.log(
				`${provider} ${one.result.padEnd(7)} ${task.id}${one.reason ? `: ${one.reason}` : ""}`,
			);
			result.tasks.push(one);
		}
	} else {
		console.log(
			`${provider}: the Test failed at ${test.stage ?? "the start"} (${test.errorCode}); skipping its tasks`,
		);
	}
	const after = await usageOf(ctx.admin, model);
	result.usage = {
		inputTokens: after.inputTokens - before.inputTokens,
		outputTokens: after.outputTokens - before.outputTokens,
		cacheReadTokens: after.cacheReadTokens - before.cacheReadTokens,
		cacheWriteTokens: after.cacheWriteTokens - before.cacheWriteTokens,
	};
	result.estimatedInputCostUsd = await inputCost(
		ctx.admin,
		provider,
		model,
		result.usage,
	);
	return result;
}

/**
 * Put the settings back as found: the provider, address and model with the
 * Anthropic key file (the key is write-only, so it cannot be read back), the
 * limits, and the on/off switch.
 */
async function restore(admin: Session, found: AiView): Promise<string | null> {
	let warning: string | null = null;
	const limits = {
		monthlyTokenCap: found.monthlyTokenCap,
		conversationTokenBudget: found.conversationTokenBudget,
	};
	if (found.baseUrl && found.model && found.providerKind === "anthropic") {
		await admin.json("PUT", "/admin/ai", {
			providerKind: found.providerKind,
			baseUrl: found.baseUrl,
			model: found.model,
			key: readKey("anthropic"),
			...limits,
		});
	} else {
		await admin.json("PUT", "/admin/ai", limits);
		warning =
			"the provider found was not Anthropic, so its key was not restored; set it on the AI tab";
	}
	await admin.json("PUT", "/admin/ai", { enabled: found.enabled && warning === null });
	return warning;
}

function markdown(results: ProviderResult[], started: string): string {
	const lines = [
		`# Model check ${started}${dryRun ? " (dry run)" : ""}`,
		"",
		"| Task | Provider | Result | Reason | Tokens |",
		"|---|---|---|---|---|",
	];
	for (const r of results) {
		for (const t of r.tasks) {
			lines.push(
				`| ${t.id} | ${r.provider} | ${t.result} | ${t.reason} | ${t.tokens} |`,
			);
		}
	}
	lines.push("");
	for (const r of results) {
		const passed = r.tasks.filter((t) => t.result === "pass").length;
		const cost =
			r.estimatedInputCostUsd === null
				? "unknown (no price row for this model)"
				: `about $${r.estimatedInputCostUsd.toFixed(4)}`;
		lines.push(
			`- **${r.provider}** (${r.model}): Test ${r.test.ok ? "passed" : `failed at ${r.test.stage ?? "start"} (${r.test.errorCode})`}; ${passed} of ${r.tasks.length} tasks passed; input ${r.usage?.inputTokens ?? 0}, output ${r.usage?.outputTokens ?? 0}, cache read ${r.usage?.cacheReadTokens ?? 0}, cache write ${r.usage?.cacheWriteTokens ?? 0} tokens; input-side cost ${cost}; output tokens are not priced, because the price table holds no output price.`,
		);
	}
	return `${lines.join("\n")}\n`;
}

async function main(): Promise<number> {
	const started = new Date().toISOString().replace(/[:.]/g, "-");
	const admin = await signInAdmin();
	const me = await admin.json<{ id: string }>("GET", "/auth/me");
	const found = await admin.json<AiView>("GET", "/admin/ai");
	if (found.noticeVersion !== AI_NOTICE_VERSION) {
		if (!dryRun) fail("accept the privacy notice on the AI tab first");
		await admin.json("POST", "/admin/ai/notice", { noticeVersion: AI_NOTICE_VERSION });
	}
	const sqlUrl = env("TEST_DATABASE_URL");
	const sshHost = env("MODEL_CHECK_SSH");
	const sql = dryRun
		? sqlUrl
			? localSql(sqlUrl)
			: fail("the dry run needs TEST_DATABASE_URL")
		: sshHost
			? sshSql(sshHost)
			: null;
	const fixtures = new Fixtures(
		admin,
		run,
		sql,
		env("MODEL_CHECK_WORKSPACE_ID") ?? null,
		dryRun,
	);
	let instructor: Promise<{ session: Session; id: string }> | null = null;
	const instructorOnce = () => {
		instructor ??= fixtures.instructor().then(async (session) => ({
			session,
			id: (await session.json<{ id: string }>("GET", "/auth/me")).id,
		}));
		return instructor;
	};

	const results: ProviderResult[] = [];
	let warning: string | null = null;
	let cleanupFailures = 0;
	try {
		for (const provider of providers) {
			results.push(
				await runProvider(provider, {
					admin,
					adminId: me.id,
					instructor: instructorOnce,
					fixtures,
				}),
			);
		}
	} finally {
		cleanupFailures = await fixtures.cleanUp();
		warning = await restore(admin, found);
	}

	mkdirSync(RESULTS_DIR, { recursive: true });
	const report = { run, started, dryRun, site: base, results, cleanupFailures };
	writeFileSync(
		join(RESULTS_DIR, `${started}.json`),
		`${JSON.stringify(report, null, 2)}\n`,
	);
	writeFileSync(join(RESULTS_DIR, `${started}.md`), markdown(results, started));
	console.log(`model-check: results in ${join(RESULTS_DIR, started)}.{json,md}`);
	if (cleanupFailures > 0)
		console.log(
			`model-check: ${cleanupFailures} clean-up steps failed; look for modelcheck-${run}`,
		);
	if (warning) console.log(`model-check: ${warning}`);
	const allPassed = results.every(
		(r) => r.test.ok && r.tasks.every((t) => t.result === "pass"),
	);
	return allPassed && cleanupFailures === 0 ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(error: unknown) => {
		console.error(`model-check: ${error instanceof Error ? error.message : "failed"}`);
		process.exit(2);
	},
);
