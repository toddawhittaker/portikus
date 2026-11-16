import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	ask,
	holdAiSettings,
	openPanel,
	script,
	setAssistant,
} from "./assistant-helpers";
import {
	BACKUP_CHANNEL_LOCK,
	hostReport,
	hostStatus,
	resetBackups,
} from "./backup-channel";
import {
	addSession,
	DEX_ACCOUNT_ISSUER,
	expectNoViolations,
	lockSharedState,
	openAdmin,
	query,
	SETTINGS_ROW_LOCK,
	studentIn,
	WEB_ORIGIN,
} from "./helpers";

/**
 * Running the site by talking to the assistant (SPEC.md section 20.5),
 * against the real API and the fake model server: people invited in bulk
 * behind one approval typed with the row count, workspaces stopped and
 * restarted, a backup run, an egress entry added behind a typed
 * confirmation, and what an instructor is refused. Each test scripts the
 * model with its own words so parallel workers never share steps.
 */

const SOON = { timeout: 15_000 };

let restore: (() => Promise<void>) | undefined;

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
	// The wait for another spec holding the settings row counts against this hook.
	test.setTimeout(600_000);
	restore = await holdAiSettings();
});
test.afterAll(async () => {
	await restore?.();
});

test.beforeEach(async ({ page }) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await openAdmin(page);
	await setAssistant(page, true);
});

/** Open a fresh conversation, send `text`, and return the panel and its first card. */
async function askForCard(
	page: Page,
	text: string,
): Promise<{ panel: Locator; card: Locator }> {
	const panel = await openPanel(page);
	await panel.getByRole("button", { name: "New conversation" }).click();
	await ask(panel, text);
	const card = panel.getByTestId("approval-card").first();
	await expect(card).toBeVisible(SOON);
	return { panel, card };
}

function typeBox(card: Locator): Locator {
	return card.getByRole("textbox", { name: /^Type .+ to approve$/ });
}

test("inviting three people as students takes one approval typed with the row count", async ({
	page,
}) => {
	const tag = randomUUID().slice(0, 8);
	const emails = [1, 2, 3].map((n) => `${tag}-${n}@e2e-assistant.test`);
	await script(`e2e-invite-${tag}`, [
		{
			toolCalls: [
				{
					name: "run_batch",
					arguments: {
						operation: "invitations.create",
						rows: emails.map((email, at) => ({
							body: { email, name: `Student ${at + 1}`, role: "student" },
						})),
					},
				},
			],
		},
		{ text: `All three invited ${tag}.` },
	]);
	try {
		const { panel, card } = await askForCard(page, `e2e-invite-${tag}`);
		await expect(card.getByTestId("approval-risk")).toHaveText("Change");
		const table = card.getByRole("table", { name: "3 rows for invitations.create" });
		await expect(table.getByRole("columnheader")).toHaveText([
			"Row",
			"email",
			"name",
			"role",
		]);
		const rows = table.locator("tbody tr");
		await expect(rows).toHaveCount(3);
		for (const [at, email] of emails.entries()) {
			await expect(rows.nth(at).getByRole("rowheader")).toHaveText(String(at + 1));
			await expect(rows.nth(at)).toContainText(email);
		}
		await expectNoViolations(page, "#pk-assistant-panel");

		// A change batch still asks for the count; the wrong one keeps Approve locked.
		const approve = card.getByRole("button", { name: "Approve" });
		await expect(typeBox(card)).toBeFocused();
		await expect(card.getByText("Type 3 to approve")).toBeVisible();
		await expect(approve).toBeDisabled();
		await typeBox(card).fill("2");
		await expect(approve).toBeDisabled();
		await typeBox(card).fill("3");
		await expect(approve).toBeEnabled();
		await approve.click();

		await expect(card.getByTestId("approval-outcome")).toHaveText("Approved");
		await expect(panel.getByText(`All three invited ${tag}.`)).toBeVisible(SOON);
		const made = await query<{ email: string; role: string }>(
			"select email, role from account_invitations where email like $1 order by email",
			[`${tag}-%`],
		);
		expect(made).toEqual(emails.map((email) => ({ email, role: "student" })));
		const used = await query<{ n: string }>(
			`select count(*) as n from audit_events
			 where action = 'assistant.used' and metadata->>'operation' = 'invitations.create'
			   and at > now() - interval '1 minute'`,
		);
		expect(Number(used[0]?.n)).toBeGreaterThanOrEqual(3);
	} finally {
		await query("delete from account_invitations where email like $1", [`${tag}-%`]);
	}
});

test("a long batch scrolls inside its card, which the keyboard can reach, and a denial runs nothing", async ({
	page,
}) => {
	const tag = randomUUID().slice(0, 8);
	const emails = Array.from(
		{ length: 14 },
		(_, at) => `${tag}-${at + 1}@e2e-assistant.test`,
	);
	await script(`e2e-long-${tag}`, [
		{
			toolCalls: [
				{
					name: "run_batch",
					arguments: {
						operation: "invitations.create",
						rows: emails.map((email) => ({
							body: { email, name: "Student", role: "student" },
						})),
					},
				},
			],
		},
		{ text: `Left alone ${tag}.` },
	]);
	const { panel, card } = await askForCard(page, `e2e-long-${tag}`);
	await expect(card.getByText("Type 14 to approve")).toBeVisible();
	const region = card.getByRole("region", { name: "Rows for invitations.create" });
	await expect(region.locator("tbody tr")).toHaveCount(14);
	const scrolls = await region.evaluate((el) => el.scrollHeight > el.clientHeight);
	expect(scrolls).toBe(true);
	await region.focus();
	await expect(region).toBeFocused();
	await expectNoViolations(page, "#pk-assistant-panel");

	await card.getByRole("button", { name: "Deny" }).click();
	await expect(card.getByTestId("approval-outcome")).toHaveText("Denied");
	await expect(panel.getByText(`Left alone ${tag}.`)).toBeVisible(SOON);
	const made = await query("select id from account_invitations where email like $1", [
		`${tag}-%`,
	]);
	expect(made).toEqual([]);
});

test("a workspace is stopped and another restarted, each behind its own change card", async ({
	page,
	browser,
}) => {
	const tag = randomUUID().slice(0, 8);
	const stopped = await studentIn(browser, "Stop me");
	const restarted = await studentIn(browser, "Restart me");
	await script(`e2e-stop-${tag}`, [
		{
			toolCalls: [
				{ name: "workspaces_stop", arguments: { path: { id: stopped.workspaceId } } },
			],
		},
		{
			toolCalls: [
				{
					name: "workspaces_restart",
					arguments: { path: { id: restarted.workspaceId } },
				},
			],
		},
		{ text: `Both handled ${tag}.` },
	]);
	const { panel, card } = await askForCard(page, `e2e-stop-${tag}`);
	await expect(card.getByTestId("approval-risk")).toHaveText("Change");
	await expect(card.getByText("workspaces_stop")).toBeVisible();
	await expect(card.getByRole("textbox")).toHaveCount(0);
	await expect(card.getByTestId("approval-inputs")).toContainText(stopped.workspaceId);
	await card.getByRole("button", { name: "Approve" }).click();

	// The panel shows one card at a time: the next replaces the answered one.
	const second = panel.getByTestId("approval-card");
	await expect(second.getByText("workspaces_restart")).toBeVisible(SOON);
	await expect(second.getByTestId("approval-outcome")).toHaveCount(0);
	await expect(second.getByTestId("approval-inputs")).toContainText(
		restarted.workspaceId,
	);
	await second.getByRole("button", { name: "Approve" }).click();
	await expect(second.getByTestId("approval-outcome")).toHaveText("Approved");
	await expect(panel.getByText(`Both handled ${tag}.`)).toBeVisible(SOON);

	const desired = async (id: string) =>
		(
			await query<{ desired_state: string }>(
				"select desired_state from workspaces where id = $1",
				[id],
			)
		)[0]?.desired_state;
	expect(await desired(stopped.workspaceId)).toBe("stopped");
	expect(await desired(restarted.workspaceId)).toBe("restarting");
});

test("a backup is run behind a change card and the host is asked once", async ({
	page,
}) => {
	const tag = randomUUID().slice(0, 8);
	await script(`e2e-backup-${tag}`, [
		{ toolCalls: [{ name: "backups_run", arguments: {} }] },
		{ text: `Backup asked for ${tag}.` },
	]);
	// Waiting for another spec to let go of the channel counts against the test.
	test.setTimeout(600_000);
	const release = await lockSharedState(BACKUP_CHANNEL_LOCK);
	try {
		await resetBackups();
		hostReport(hostStatus());
		const { panel, card } = await askForCard(page, `e2e-backup-${tag}`);
		await expect(card.getByTestId("approval-risk")).toHaveText("Change");
		await expect(card.getByText("backups_run")).toBeVisible();
		await expect(card.getByText("No inputs")).toBeVisible();
		await card.getByRole("button", { name: "Approve" }).click();
		await expect(card.getByTestId("approval-outcome")).toHaveText("Approved");
		await expect(panel.getByText(`Backup asked for ${tag}.`)).toBeVisible(SOON);
		const asked = await query<{ kind: string }>("select kind from backup_requests");
		expect(asked).toEqual([{ kind: "backup" }]);
	} finally {
		await resetBackups();
		await release();
	}
});

test("an egress allow-list entry is a destructive card, locked until its name is typed", async ({
	page,
}) => {
	const tag = randomUUID().slice(0, 8);
	const host = `${tag}.e2e-assistant.test`;
	test.setTimeout(600_000);
	const release = await lockSharedState(SETTINGS_ROW_LOCK);
	try {
		const [{ egress_version: version } = { egress_version: 0 }] = await query<{
			egress_version: number;
		}>("select egress_version from settings where id = 1");
		await script(`e2e-egress-${tag}`, [
			{
				toolCalls: [
					{
						name: "egress_add_entry",
						arguments: { body: { version, kind: "host", value: host, label: "" } },
					},
				],
			},
			{ text: `Allowed ${tag}.` },
		]);
		const { panel, card } = await askForCard(page, `e2e-egress-${tag}`);
		await expect(card.getByTestId("approval-risk")).toHaveText("Destructive");
		await expect(card.getByTestId("approval-inputs")).toContainText(host);
		const approve = card.getByRole("button", { name: "Approve" });
		await expect(approve).toBeDisabled();
		await typeBox(card).fill("egress.add_entr");
		await expect(approve).toBeDisabled();
		await typeBox(card).fill("egress.add_entry");
		await expect(approve).toBeEnabled();
		await approve.click();
		await expect(card.getByTestId("approval-outcome")).toHaveText("Approved");
		await expect(panel.getByText(`Allowed ${tag}.`)).toBeVisible(SOON);
		const entries = await query<{ kind: string }>(
			"select kind from egress_entries where value = $1",
			[host],
		);
		expect(entries).toEqual([{ kind: "host" }]);
	} finally {
		await query("delete from egress_entries where value like $1", [
			`%.e2e-assistant.test`,
		]);
		await query(`update settings set egress_version = egress_version + 1 where id = 1`);
		await query(
			`update settings set egress_applied_version = egress_version,
			 egress_applied_at = now(), egress_apply_error = null where id = 1`,
		);
		await release();
	}
});

test("an instructor's assistant refuses an administrator's operation and draws no card", async ({
	page,
	browser,
}) => {
	const tag = randomUUID().slice(0, 8);
	const subject = `e2e-${randomUUID()}`;
	const [instructor] = await query<{ id: string }>(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role)
		 values ($1, $2, $3, 'E2E Instructor', 'instructor') returning id`,
		[DEX_ACCOUNT_ISSUER, subject, `${subject}@example.edu`],
	);
	if (!instructor) throw new Error("could not create the instructor");
	await script(`e2e-refused-${tag}`, [
		{
			toolCalls: [
				{
					name: "run_batch",
					arguments: {
						operation: "egress.add_entry",
						rows: [
							{
								body: {
									version: 0,
									kind: "host",
									value: `${tag}.e2e-assistant.test`,
									label: "",
								},
							},
						],
					},
				},
				{
					name: "run_operation",
					arguments: {
						operation: "users.disable",
						input: { path: { id: instructor.id } },
					},
				},
			],
		},
		{ text: `Neither is mine to run ${tag}.` },
	]);
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	try {
		await addSession(context, instructor.id);
		const created = await context.request.post("/assistant/conversations", {
			headers: { origin: WEB_ORIGIN },
			data: {},
		});
		expect(created.status(), await created.text()).toBe(201);
		const { id } = (await created.json()) as { id: string };
		const other = await context.newPage();
		await other.goto("/");
		const seen = await other.evaluate(
			({ id, text }) =>
				new Promise<{ types: string[]; outputs: string[]; text: string }>(
					(resolve, reject) => {
						const socket = new WebSocket(
							`${location.origin.replace(/^http/, "ws")}/assistant/conversations/${id}/socket`,
						);
						const types: string[] = [];
						const outputs: string[] = [];
						let said = "";
						const timer = setTimeout(() => reject(new Error("no reply")), 20_000);
						socket.onopen = () =>
							socket.send(JSON.stringify({ type: "send", text, attachments: [] }));
						socket.onmessage = (event) => {
							const frame = JSON.parse(event.data);
							types.push(frame.type);
							if (frame.type === "tool.output") outputs.push(frame.part.text);
							if (frame.type === "message" && frame.role === "assistant")
								said = frame.markdown;
							if (frame.type === "turn.finished") {
								clearTimeout(timer);
								socket.close();
								resolve({ types, outputs, text: said });
							}
						};
						socket.onerror = () => reject(new Error("socket error"));
					},
				),
			{ id, text: `e2e-refused-${tag}` },
		);
		expect(seen.types).not.toContain("permission.requested");
		expect(seen.outputs).toHaveLength(2);
		for (const output of seen.outputs) {
			expect(JSON.parse(output)).toMatchObject({ code: "NOT_FOUND" });
		}
		expect(seen.text).toBe(`Neither is mine to run ${tag}.`);
		const entries = await query("select id from egress_entries where value like $1", [
			`${tag}%`,
		]);
		expect(entries).toEqual([]);
		const still = await query<{ disabled_at: string | null }>(
			"select disabled_at from users where id = $1",
			[instructor.id],
		);
		expect(still[0]?.disabled_at).toBeNull();
	} finally {
		await context.close();
		await query("delete from assistant_conversations where user_id = $1", [
			instructor.id,
		]);
		await query("delete from sessions where user_id = $1", [instructor.id]);
	}
	// The administrator's own panel is untouched by all of this.
	await expect(page.getByRole("button", { name: "Assistant" })).toBeVisible();
});
