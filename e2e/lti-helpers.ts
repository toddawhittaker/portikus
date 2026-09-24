/**
 * Launch helpers for the LTI specs (docs/EPIC-13.md, "The mock LMS"). Each
 * launch drives the mock's own launch page, so the browser takes the real
 * route: the mock, the tool's /lti/login, the mock's /authorize, and the
 * form post to /lti/launch.
 */
import { expect, type Page } from "@playwright/test";
import { PEOPLE } from "../packages/mock-lms/src/seed";
import { query } from "./helpers";
import { MOCK_LMS_ORIGIN, WEB_ORIGIN } from "./ports";

export { MOCK_LMS_ORIGIN };

export type PersonKey = "ivy" | "tom" | "sam" | "lee" | "ada" | "rex" | "una";
export type CourseKey = "cs101" | "cs240" | "cs350";
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

/** The platform issuer the API stores LTI users under (ruling 12). */
export const LTI_ISSUER = `lti:${MOCK_LMS_ORIGIN}`;

export function subjectOf(key: PersonKey): string {
	const person = PEOPLE.find((p) => p.key === key);
	if (!person) throw new Error(`no seeded person ${key}`);
	return person.sub;
}

export interface LtiUserRow {
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
