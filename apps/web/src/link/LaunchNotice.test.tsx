/**
 * The notice after a launch into a linked account: it names the account, it
 * can be dismissed for the session, and Unlink ends this session.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, renderWithQuery, stubFetch } from "../test-utils.js";
import { LaunchNotice } from "./LaunchNotice.js";

const COURSE_USER = "33333333-3333-4333-8333-333333333333";

afterEach(() => {
	vi.unstubAllGlobals();
	sessionStorage.clear();
});

function stubLinks(launch: unknown) {
	const posts: string[] = [];
	stubFetch((url, init) => {
		if (url === "/me/links") {
			return json(200, { source: "sso", linkUntil: null, links: [], launch });
		}
		if (url === `/me/links/${COURSE_USER}/unlink` && init?.method === "POST") {
			posts.push(url);
			return json(200, { signedOut: true });
		}
		throw new Error(`unexpected request: ${url}`);
	});
	const assign = vi.fn();
	vi.stubGlobal("location", { ...window.location, assign });
	return { posts, assign };
}

const LAUNCH = { courseUserId: COURSE_USER, platformName: "mock-lms" };

test("a launch into a linked account names the platform and the account", async () => {
	stubLinks(LAUNCH);
	renderWithQuery(<LaunchNotice displayName="Erin Student" />);

	const notice = await screen.findByRole("region", { name: "Course sign-in" });
	expect(notice.textContent).toContain(
		"Opened from mock-lms as Erin Student. Not you?",
	);
	expect(
		within(notice).getByRole("button", { name: "Unlink this course sign-in" }),
	).toBeTruthy();
});

test("the status region is there before the launch is known, then filled (review A1)", async () => {
	stubLinks(LAUNCH);
	renderWithQuery(<LaunchNotice displayName="Erin Student" />);

	const status = screen.getByRole("status");
	expect(status.textContent).toBe("");
	await waitFor(() =>
		expect(status.textContent).toBe("Opened from mock-lms as Erin Student. Not you?"),
	);
	expect(screen.getByRole("status")).toBe(status);
});

test("no notice without a launch", async () => {
	stubLinks(null);
	renderWithQuery(<LaunchNotice displayName="Erin Student" />);
	await waitFor(() => expect(screen.queryByTestId("launch-notice")).toBeNull());
});

test("dismissing hides the notice for the session and moves focus", async () => {
	stubLinks(LAUNCH);
	renderWithQuery(
		<>
			<button type="button" data-testid="me">
				Account
			</button>
			<LaunchNotice displayName="Erin Student" />
		</>,
	);

	fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));

	expect(screen.queryByTestId("launch-notice")).toBeNull();
	expect(document.activeElement?.getAttribute("data-testid")).toBe("me");
	expect(sessionStorage.getItem("pk-launch-notice-dismissed")).toBe("1");
});

test("a dismissed notice stays hidden", async () => {
	sessionStorage.setItem("pk-launch-notice-dismissed", "1");
	stubLinks(LAUNCH);
	renderWithQuery(<LaunchNotice displayName="Erin Student" />);
	await waitFor(() => expect(screen.queryByTestId("launch-notice")).toBeNull());
});

test("Unlink asks first, then unlinks this course sign-in and signs out", async () => {
	const { posts, assign } = stubLinks(LAUNCH);
	renderWithQuery(<LaunchNotice displayName="Erin Student" />);

	fireEvent.click(
		await screen.findByRole("button", { name: "Unlink this course sign-in" }),
	);
	const dialog = await screen.findByTestId("launch-unlink-confirm");
	expect(posts).toEqual([]);

	fireEvent.click(within(dialog).getByTestId("dialog-confirm"));

	await waitFor(() => expect(assign).toHaveBeenCalledWith("/unlinked"));
	expect(posts).toEqual([`/me/links/${COURSE_USER}/unlink`]);
});

test("the unlinked page says how to continue and offers no sign-in", async () => {
	stubFetch((url) => {
		throw new Error(`unexpected request: ${url}`);
	});
	renderApp("/unlinked");

	const page = await screen.findByTestId("page-unlinked");
	expect(page.textContent).toContain(
		"Open Portikus again from your course to continue with your course account.",
	);
	expect(within(page).queryByRole("link")).toBeNull();
	expect(within(page).queryByRole("button")).toBeNull();
	await waitFor(() => expect(document.activeElement?.id).toBe("page-title"));
});
