import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	newTerminal,
	openFileTab,
	query,
	seedFile,
	startPreviewApp,
	terminalIds,
	workspacePath,
} from "./helpers";
import { pdf } from "./pdf-fixture";
import { WEB_ORIGIN } from "./ports";
import { previewGateway } from "./preview-gateway";

/**
 * The control-plane UI's content security policy (SPEC.md section 24.3).
 * The dev server writes the same meta tag the package ships
 * (apps/web/src/csp.ts), so each surface that loads code or content in
 * an unusual way is driven here, and any report of a blocked resource fails
 * the test: Monaco and its workers, xterm, the Markdown preview, the PDF
 * frame and the preview frame.
 */

interface Violation {
	directive: string;
	blocked: string;
	source: string;
}

/**
 * Collects every policy violation the page or any of its frames reports.
 * Violations inside a worker reach only the console, so those are kept too.
 */
async function watchViolations(page: Page): Promise<() => string[]> {
	const seen: string[] = [];
	await page.exposeFunction("__portikusCspViolation", (violation: Violation) => {
		seen.push(
			`${violation.directive} blocked ${violation.blocked} (${violation.source})`,
		);
	});
	await page.addInitScript(() => {
		document.addEventListener("securitypolicyviolation", (event) => {
			const report = (
				window as unknown as { __portikusCspViolation: (v: Violation) => void }
			).__portikusCspViolation;
			report({
				directive: event.effectiveDirective,
				blocked: event.blockedURI,
				source: `${event.sourceFile}:${event.lineNumber}`,
			});
		});
	});
	page.on("console", (message) => {
		if (/Content Security Policy/i.test(message.text())) seen.push(message.text());
	});
	return () => seen;
}

test.describe("content security policy", () => {
	// Monaco is a large chunk the dev server transforms on first use.
	test.describe.configure({ timeout: 90_000 });

	test("the page carries a policy that allows only its own scripts", async ({
		request,
	}) => {
		const response = await request.get(WEB_ORIGIN, {
			headers: { accept: "text/html" },
		});
		const html = await response.text();
		const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(
			html,
		)?.[1];
		expect(policy).toBeDefined();
		const directives = new Map(
			(policy ?? "").split("; ").map((part) => {
				const [name = "", ...sources] = part.split(" ");
				return [name, sources] as const;
			}),
		);
		// The dev server's one inline script is allowed by its hash, never by
		// 'unsafe-inline' or 'unsafe-eval'.
		const scripts = directives.get("script-src") ?? [];
		expect(scripts[0]).toBe("'self'");
		expect(scripts.slice(1).every((source) => source.startsWith("'sha256-"))).toBe(
			true,
		);
		expect(directives.get("object-src")).toEqual(["'none'"]);
		expect(directives.get("base-uri")).toEqual(["'self'"]);
		expect(directives.get("form-action")).toEqual(["'self'"]);
		// The policy comes before every script, so it covers all of them.
		expect(html.indexOf("Content-Security-Policy")).toBeLessThan(
			html.indexOf("<script"),
		);
	});

	test("a script the page did not ship is refused", async ({ page, context }) => {
		const violations = await watchViolations(page);
		await createStudent(context);
		await page.goto("/");
		await expect(page.getByTestId("me")).toBeVisible({ timeout: 15_000 });

		const ran = await page.evaluate(async () => {
			const flag = window as unknown as { injectedRan?: boolean };
			const script = document.createElement("script");
			script.textContent = "window.injectedRan = true";
			document.body.append(script);
			await new Promise((resolve) => setTimeout(resolve, 100));
			return flag.injectedRan === true;
		});
		expect(ran).toBe(false);
		await expect.poll(() => violations().join("\n")).toContain("script-src");
	});

	test("editing a file in Monaco reports no violation", async ({ page, context }) => {
		const violations = await watchViolations(page);
		const student = await createStudent(context);
		const path = "settings.json";
		await openFileTab(page, student, "Csp editor", path, '{\n  "port": 3000\n}\n');

		const lines = page.getByTestId(`editor-${path}`).locator(".view-lines");
		await expect(lines).toContainText('"port"', { timeout: 60_000 });
		await lines.click();
		await page.keyboard.press("End");
		await page.keyboard.type(' "edited"');
		await expect(lines).toContainText('"edited"');
		// Hovering runs the JSON worker and shows a Monaco widget.
		await page.getByText('"port"').hover();
		await page.waitForTimeout(500);
		expect(violations()).toEqual([]);
	});

	test("the Markdown preview and the PDF viewer report no violation", async ({
		page,
		context,
	}) => {
		const violations = await watchViolations(page);
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Csp docs" });
		await seedFile(
			student.workspaceId,
			project.slug,
			"diagram.svg",
			'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#2f7d6d"/></svg>',
		);
		const path = "README.md";
		await seedFile(
			student.workspaceId,
			project.slug,
			path,
			"## Notes\n\n![Diagram](diagram.svg)\n\n| Port | Use |\n| --- | --- |\n| 3000 | web |\n",
		);
		await query("update projects set layout = $2 where id = $1", [
			project.id,
			JSON.stringify({ tabs: [{ id: `file:${path}`, root: { type: "file", path } }] }),
		]);
		await page.goto(workspacePath(student.workspaceId, project.id));
		const preview = page.getByTestId("markdown-preview");
		await expect(preview.getByRole("heading", { name: "Notes" })).toBeVisible({
			timeout: 60_000,
		});
		await expect(preview.getByRole("img", { name: "Diagram" })).toHaveJSProperty(
			"complete",
			true,
		);
		expect(violations()).toEqual([]);

		await openFileTab(page, student, "Csp pdf", "brief.pdf", pdf());
		await expect(page.getByTitle("brief.pdf, PDF")).toBeVisible({ timeout: 15_000 });
		await page.waitForTimeout(500);
		expect(violations()).toEqual([]);
	});

	test("a terminal connects and echoes typing with no violation", async ({
		page,
		context,
	}) => {
		const violations = await watchViolations(page);
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Csp terminal" });
		await page.goto(workspacePath(student.workspaceId, project.id));
		await newTerminal(page);
		await expect(page.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
		const [id] = await terminalIds(student.workspaceId);
		if (!id) throw new Error("the terminal row was not created");
		await expectConnected(page, id);
		const pane = page.getByTestId(`terminal-pane-${id}`);
		await expect(pane.locator(".xterm-screen")).toBeVisible();
		await pane.locator(".xterm-screen").click();
		await page.keyboard.type("echo csp");
		await page.waitForTimeout(500);
		expect(violations()).toEqual([]);
	});

	test("a preview frame loads with no violation", async ({ page, context }) => {
		const violations = await watchViolations(page);
		const student = await createStudent(context);
		await previewGateway(page);
		const port = await startPreviewApp(student.workspaceId, "Csp app");
		const project = await createProject(student.workspaceId, { name: "Csp preview" });
		await page.goto(workspacePath(student.workspaceId, project.id));

		await page.getByTestId("right-pane-tab-running").click();
		await page.getByTestId(`running-open-${port}`).click({ timeout: 20_000 });
		await expect(
			page.frameLocator("[data-testid=preview-frame]").locator("h1"),
		).toHaveText("Csp app", { timeout: 20_000 });
		expect(violations()).toEqual([]);
	});
});
