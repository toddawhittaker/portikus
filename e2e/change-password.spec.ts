import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { writeDexGrpcCerts } from "../packages/auth/dist/testing/fake-dex-grpc.js";
import { loginAs, MOCK_ISSUER, query, WEB_ORIGIN } from "./helpers";
import { FAKE_DEX_GRPC_PORT } from "./ports";

/**
 * The local administrator's first sign-in and Settings, Password
 * (docs/EPIC-14-2.md rulings 16 to 19, ADR 0031). `reset-admin-main` runs
 * against this run's database and the fake Dex gRPC API, and the mock
 * provider's "admin" user carries the local administrator's Dex subject.
 * The tests share that one account, so they run in order.
 */
test.describe.configure({ mode: "serial" });

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:portikus@127.0.0.1:55432/portikus_test";
const certs = writeDexGrpcCerts(
	join(tmpdir(), `portikus-e2e-dex-${FAKE_DEX_GRPC_PORT}`),
	"e2e",
);

/** Run `portikus reset-admin` the way the host does; stdout is only the password. */
function resetAdmin(): string {
	const out = execFileSync(
		process.execPath,
		["packages/auth/dist/reset-admin-main.js", "--email", "admin@example.edu"],
		{
			env: {
				...process.env,
				DATABASE_URL,
				DEX_GRPC_ADDR: `127.0.0.1:${FAKE_DEX_GRPC_PORT}`,
				DEX_GRPC_CA: certs.ca,
				DEX_GRPC_CERT: certs.clientCert,
				DEX_GRPC_KEY: certs.clientKey,
				OIDC_ISSUER_URL: MOCK_ISSUER,
				PUBLIC_URL: WEB_ORIGIN,
			},
			encoding: "utf8",
		},
	);
	const password = out.trim();
	expect(password).toMatch(/^[A-Za-z0-9]{20}$/);
	return password;
}

async function signInAsAdmin(page: Page) {
	await loginAs(page, "admin");
	await expect(page).toHaveURL(/\/change-password$/, { timeout: 15_000 });
	await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible();
}

async function submit(page: Page, current: string, next: string) {
	await page.getByLabel("Current password").fill(current);
	await page.getByLabel("New password", { exact: true }).fill(next);
	await page.getByLabel("New password again").fill(next);
	await page.getByRole("button", { name: "Change password" }).click();
}

async function openSettings(page: Page) {
	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	const dialog = page.getByTestId("dialog-editor-settings");
	await expect(dialog).toBeVisible();
	return dialog;
}

let oneTime = "";

test("every page lands on Set a new password while the flag is set", async ({
	page,
}) => {
	oneTime = resetAdmin();
	await signInAsAdmin(page);
	for (const path of ["/", "/admin", "/course", `/workspaces/${crypto.randomUUID()}`]) {
		await page.goto(path);
		await expect(page).toHaveURL(/\/change-password$/, { timeout: 15_000 });
		await expect(
			page.getByRole("heading", { name: "Set a new password" }),
		).toBeVisible();
	}
	// The server refuses the rest too (ruling 18).
	const blocked = await page.request.get("/admin/users");
	expect(blocked.status()).toBe(403);
	expect((await blocked.json()).code).toBe("PASSWORD_CHANGE_REQUIRED");
});

test("a wrong current password is shown on that field, which keeps focus", async ({
	page,
}) => {
	await signInAsAdmin(page);
	await submit(page, "not the password", "a brand new long password");
	const current = page.getByLabel("Current password");
	await expect(current).toHaveAccessibleDescription(
		"The current password is not right.",
	);
	await expect(current).toBeFocused();
	await expect(page).toHaveURL(/\/change-password$/);
});

test("a short password is refused with the rule shown", async ({ page }) => {
	await signInAsAdmin(page);
	await submit(page, oneTime, "too short");
	const next = page.getByLabel("New password", { exact: true });
	await expect(next).toBeFocused();
	await expect(next).toHaveAccessibleDescription(/Use at least 15 characters\./);
	await expect(next).toHaveAccessibleDescription(/At least 15 characters\./);
});

test("a good change lands on the administration page and Settings offers Password", async ({
	page,
}) => {
	await signInAsAdmin(page);
	await submit(page, oneTime, "correct horse battery staple");
	await expect(
		page.getByText("Password changed. The one-time password no longer works.", {
			exact: true,
		}),
	).toBeVisible();
	// An administrator's front page (issue #534), with the administrator's header.
	await expect(page).toHaveURL(/\/admin$/, { timeout: 15_000 });
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
	const [row] = await query<{ must_change_password: boolean; role: string }>(
		"select must_change_password, role from users where oidc_issuer = $1 and email = $2",
		[MOCK_ISSUER, "admin@example.edu"],
	);
	expect(row).toEqual({ must_change_password: false, role: "administrator" });

	const dialog = await openSettings(page);
	await dialog.getByRole("button", { name: "Password", exact: true }).click();
	await expect(
		dialog.getByRole("heading", { name: "Password", exact: true }),
	).toBeVisible();
	await dialog.getByLabel("Current password").fill("correct horse battery staple");
	await dialog
		.getByLabel("New password", { exact: true })
		.fill("another long passphrase");
	await dialog.getByLabel("New password again").fill("another long passphrase");
	await dialog.getByRole("button", { name: "Change password" }).click();
	await expect(dialog.getByRole("status")).toHaveText(
		"Your password has been changed.",
	);
});

test("an SSO account has no Password section", async ({ page }) => {
	await loginAs(page, "alice");
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });
	const dialog = await openSettings(page);
	await expect(dialog.getByRole("button", { name: "Profile" })).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Password", exact: true }),
	).toHaveCount(0);
});

test("the setup page is gone", async ({ page }) => {
	await page.goto("/setup");
	await expect(page.getByText("Not Found")).toBeVisible();
});
