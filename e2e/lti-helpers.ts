/**
 * Launch helpers for the LTI specs (ADR 0025). Each
 * launch drives the mock's own launch page, so the browser takes the real
 * route: the mock, the tool's /lti/login, the mock's /authorize, and the
 * form post to /lti/launch.
 */
import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { PEOPLE } from "../packages/mock-lms/src/seed";
import { query } from "./helpers";
import { MOCK_LMS_ORIGIN, WEB_ORIGIN } from "./ports";

export { MOCK_LMS_ORIGIN };

export type PersonKey =
	| "ivy"
	| "tom"
	| "sam"
	| "lee"
	| "ada"
	| "lin"
	| "max"
	| "rex"
	| "una"
	| "roy";
type CourseKey = "cs101" | "cs240" | "cs330" | "cs350";
export type Defect =
	| "bad_signature"
	| "wrong_aud"
	| "expired"
	| "replayed_nonce"
	| "unknown_deployment"
	| "wrong_message_type"
	| "wrong_version"
	| "alg_none"
	| "wrong_target";

export interface LaunchOptions {
	person: PersonKey;
	course?: CourseKey;
	defect?: Defect;
	frame?: boolean;
}

/** Fill in the mock's launch page and submit it, without waiting for the outcome. */
export async function startLaunch(page: Page, options: LaunchOptions): Promise<void> {
	await page.goto(`${MOCK_LMS_ORIGIN}/`);
	await page.getByLabel("Person").selectOption(options.person);
	await page.getByLabel("Course").selectOption(options.course ?? "cs101");
	if (options.defect) await page.getByLabel("Defect").selectOption(options.defect);
	if (options.frame) await page.getByLabel("Open inside a frame").check();
	await page.getByRole("button", { name: "Launch Portikus" }).click();
}

/** A good launch: wait until the browser is back in the web app, signed in. */
export async function launchAs(page: Page, options: LaunchOptions): Promise<void> {
	await startLaunch(page, options);
	await page.waitForURL(`${WEB_ORIGIN}/**`, { timeout: 30_000 });
	// The first load of the app under a full parallel run can be slow.
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 30_000 });
}

/** Open Deep Linking as this person; the tool's picker page loads in the same tab. */
export async function startDeepLinking(
	page: Page,
	options: { person: PersonKey; course?: CourseKey },
): Promise<void> {
	await page.goto(`${MOCK_LMS_ORIGIN}/`);
	await page
		.getByLabel("Instructor starting Deep Linking")
		.selectOption(options.person);
	await page
		.getByLabel("Class for Deep Linking")
		.selectOption(options.course ?? "cs101");
	await page.getByRole("button", { name: "Start Deep Linking" }).click();
}

/** Launch a link saved by Deep Linking, by its title, and wait for the web app. */
export async function launchSavedLink(
	page: Page,
	options: { title: string; person?: PersonKey },
): Promise<void> {
	await page.goto(`${MOCK_LMS_ORIGIN}/`);
	const link = page.getByLabel("Link", { exact: true });
	const value = await link
		.locator("option")
		.filter({ hasText: options.title })
		.first()
		.getAttribute("value");
	if (!value) throw new Error(`no saved link titled ${options.title}`);
	await link.selectOption(value);
	await page.getByLabel("Launch as").selectOption(options.person ?? "sam");
	await page.getByRole("button", { name: "Launch saved link" }).click();
	await page.waitForURL(`${WEB_ORIGIN}/**`, { timeout: 30_000 });
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 30_000 });
}

export interface RosterChange {
	action: "add" | "drop" | "role" | "reset";
	course?: CourseKey;
	person?: string;
	role?: "Instructor" | "TeachingAssistant" | "Learner" | "Administrator";
}

/** Change a mock course roster; the next roster sync sees it. */
export async function changeRoster(
	request: APIRequestContext,
	change: RosterChange,
): Promise<void> {
	const home = await (await request.get(`${MOCK_LMS_ORIGIN}/`)).text();
	const formToken = /name="form_token" value="([^"]+)"/.exec(home)?.[1];
	if (!formToken) throw new Error("the mock's launch page has no form token");
	const fields: Record<string, string> = {
		form_token: formToken,
		action: change.action,
	};
	if (change.course) fields.course = change.course;
	if (change.person) fields.person = change.person;
	if (change.role) fields.role = change.role;
	const res = await request.post(`${MOCK_LMS_ORIGIN}/roster`, { form: fields });
	expect(res.status(), await res.text()).toBe(204);
}

/** The platform issuer the API stores LTI users under. */
const LTI_ISSUER = `lti:${MOCK_LMS_ORIGIN}`;

function subjectOf(key: PersonKey): string {
	const person = PEOPLE.find((p) => p.key === key);
	if (!person) throw new Error(`no seeded person ${key}`);
	return person.sub;
}

interface LtiUserRow {
	id: string;
	role: string;
	display_name: string;
}

export async function ltiUsers(key: PersonKey): Promise<LtiUserRow[]> {
	return query<LtiUserRow>(
		"select id, role, display_name from users where oidc_issuer = $1 and oidc_subject = $2",
		[LTI_ISSUER, subjectOf(key)],
	);
}

/** Whether this page's browser context holds a Portikus session. */
export async function signedIn(page: Page): Promise<boolean> {
	const me = await page.request.get(`${WEB_ORIGIN}/auth/me`);
	return me.status() === 200;
}

/** The header's Course link opens a new tab, like Administration; return that tab. */
export async function openCourseTab(page: Page): Promise<Page> {
	const link = page.getByRole("link", { name: "Course" });
	await expect(link).toHaveAttribute("target", "_blank");
	const [tab] = await Promise.all([page.context().waitForEvent("page"), link.click()]);
	await tab.waitForLoadState();
	return tab;
}
