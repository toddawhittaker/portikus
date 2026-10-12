/**
 * The fake speech recognition and terminal setup the voice input specs
 * share (SPEC.md section 25.10).
 */
import { expect, type Page } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	query,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";

export interface FakeSpeechWindow {
	__speech: {
		started: number;
		stopped: number;
		say: (text: string, isFinal: boolean) => void;
		fail: (error: string) => void;
	};
}

/** Install a SpeechRecognition the test can drive through `window.__speech`. */
export async function fakeSpeech(page: Page): Promise<void> {
	await page.addInitScript(() => {
		type Handler = ((event: unknown) => void) | null;
		const control = {
			started: 0,
			stopped: 0,
			current: null as null | { onresult: Handler; onerror: Handler; onend: Handler },
			say(text: string, isFinal: boolean) {
				const result = Object.assign([{ transcript: text }], { isFinal });
				control.current?.onresult?.({ resultIndex: 0, results: [result] });
			},
			fail(error: string) {
				control.current?.onerror?.({ error });
				control.current?.onend?.(undefined);
			},
		};
		class FakeRecognition {
			continuous = false;
			interimResults = false;
			lang = "";
			onresult: Handler = null;
			onerror: Handler = null;
			onend: Handler = null;
			start() {
				control.started += 1;
				control.current = this;
			}
			stop() {
				control.stopped += 1;
				queueMicrotask(() => this.onend?.(undefined));
			}
			abort() {}
		}
		Object.assign(window, {
			__speech: control,
			SpeechRecognition: FakeRecognition,
			webkitSpeechRecognition: FakeRecognition,
		});
	});
}

export async function openTerminal(
	page: Page,
	context: Parameters<typeof createStudent>[0],
	appearance?: "light" | "dark",
) {
	const student = await createStudent(context);
	if (appearance) {
		await query(
			"update users set editor_settings = editor_settings || $1::jsonb where id = $2",
			[JSON.stringify({ appearance }), student.userId],
		);
	}
	const project = await createProject(student.workspaceId, { name: "Voice" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	if (appearance) {
		await expect(page.locator("html")).toHaveAttribute("data-theme", appearance);
	}
	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-terminal").click();
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(1);
	const [id] = await terminalIds(student.workspaceId, project.id);
	if (!id) throw new Error("the terminal row was not created");
	await expectConnected(page, id);
	return id;
}
