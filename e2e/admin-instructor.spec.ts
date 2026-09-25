import * as crypto from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";
import {
	createStudent,
	loginAs,
	MOCK_ISSUER,
	query,
	settledAxe,
	WEB_ORIGIN,
} from "./helpers";

/**
 * Make instructor and Remove instructor in the Users view (docs/archive/epics/EPIC-14.md
 * ruling 14). Every test acts on accounts of its own.
 */

async function expectNoViolations(page: Page, selector: string) {
	const results = await (await settledAxe(page))
		.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
		.include(selector)
		.analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

async function openUsers(page: Page): Promise<void> {
	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
}

async function openDetail(page: Page, name: string) {
	await page.getByTestId("admin-filter-text").fill(name);
	await page.getByRole("button", { name: `Show details for ${name}` }).click();
	return page.getByRole("region", { name });
}

/** A signed-in student in a browser context of its own, with a readable name. */
async function signedInStudent(browser: Browser, name: string) {
	const context = await browser.newContext({ baseURL: WEB_ORIGIN });
	const student = await createStudent(context);
	await query("update users set display_name = $2 where id = $1", [
		student.userId,
		name,
	]);
	return { context, ...student };
}

async function roleOf(page: Page): Promise<string> {
	const res = await page.request.get("/auth/me");
	return (await res.json()).role;
}

test("make instructor takes effect on the next request, and remove instructor undoes it", async ({
	page,
	browser,
}) => {
	const name = `Teach ${crypto.randomUUID().slice(0, 8)}`;
	const student = await signedInStudent(browser, name);
	const studentPage = await student.context.newPage();
	try {
		expect(await roleOf(studentPage)).toBe("student");

		await openUsers(page);
		const panel = await openDetail(page, name);
		const make = panel.getByRole("button", { name: `Make instructor: ${name}` });
		await make.click();
		const dialog = page.getByRole("alertdialog", {
			name: `Make ${name} an instructor?`,
		});
		await expectNoViolations(page, "[data-testid=make-instructor-dialog]");
		await dialog.getByRole("button", { name: "Make instructor" }).click();
		await expect(dialog).toBeHidden();
		await expect(page.getByTestId(`account-role-${student.userId}`)).toHaveText(
			"Instructor (granted)",
		);
		// The session is kept; its next request reads the new role.
		expect(await roleOf(studentPage)).toBe("instructor");

		const remove = panel.getByRole("button", { name: `Remove instructor: ${name}` });
		await expect(remove).toBeFocused();
		await remove.click();
		const undo = page.getByRole("alertdialog", {
			name: `Remove instructor from ${name}?`,
		});
		await expect(undo).toContainText("They go back to Student");
		await expectNoViolations(page, "[data-testid=remove-instructor-dialog]");
		await undo.getByRole("button", { name: "Remove instructor" }).click();
		await expect(undo).toBeHidden();
		await expect(page.getByTestId(`account-role-${student.userId}`)).toHaveText(
			"Student",
		);
		expect(await roleOf(studentPage)).toBe("student");

		const audits = await query<{
			metadata: { from: string; to: string; source: string };
		}>(
			`select metadata from audit_events
			 where action = 'user.role_changed' and target = $1 order by id`,
			[student.userId],
		);
		expect(
			audits.map((a) => [a.metadata.from, a.metadata.to, a.metadata.source]),
		).toEqual([
			["student", "instructor", "admin"],
			["instructor", "student", "admin"],
		]);
	} finally {
		await student.context.close();
	}
});

test("a course account cannot be made an instructor, in the page or by the route", async ({
	page,
}) => {
	const name = `Course ${crypto.randomUUID().slice(0, 8)}`;
	const [row] = await query<{ id: string }>(
		`insert into users (oidc_issuer, oidc_subject, email, display_name, role, provider_role)
		 values ($1, $2, null, $3, 'student', 'student') returning id`,
		["lti:https://lms-e2e.example.edu", `e2e-${crypto.randomUUID()}`, name],
	);
	const id = row?.id ?? "";
	await openUsers(page);
	const panel = await openDetail(page, name);
	const make = panel.getByRole("button", { name: `Make instructor: ${name}` });
	await expect(make).toHaveAttribute("aria-disabled", "true");
	await expect(panel.getByText("Only SSO accounts can be instructors.")).toBeVisible();

	const response = await page.request.post(`/admin/users/${id}/make-instructor`, {
		headers: { origin: WEB_ORIGIN },
	});
	expect(response.status()).toBe(400);
	expect((await response.json()).message).toBe("Only SSO accounts can be instructors.");
	const [after] = await query<{ granted_role: string | null }>(
		"select granted_role from users where id = $1",
		[id],
	);
	expect(after?.granted_role).toBeNull();
});

test("a granted administrator must be demoted before being made an instructor", async ({
	page,
}) => {
	const name = `Granted ${crypto.randomUUID().slice(0, 8)}`;
	await query(
		`insert into users
		   (oidc_issuer, oidc_subject, email, display_name, role, provider_role, granted_role)
		 values ($1, $2, null, $3, 'administrator', 'student', 'administrator')`,
		[MOCK_ISSUER, `e2e-${crypto.randomUUID()}`, name],
	);
	await openUsers(page);
	const panel = await openDetail(page, name);
	const make = panel.getByRole("button", { name: `Make instructor: ${name}` });
	await expect(make).toHaveAttribute("aria-disabled", "true");
	await expect(
		panel.getByText("This account is a granted administrator. Demote first."),
	).toBeVisible();
});
