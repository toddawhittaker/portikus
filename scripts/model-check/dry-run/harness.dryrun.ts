import { spawn } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { apiLoginAs, WEB_ORIGIN } from "../../../e2e/helpers";
import { FAKE_MODEL_PORT } from "../../../e2e/ports";

/**
 * The model check's whole harness (scripts/model-check/run.ts) against the
 * fake model: every task must pass, and the AI settings must end as they
 * began, which here is an Anthropic model that is switched on.
 */
const root = join(import.meta.dirname, "../../..");
const BEFORE = {
	providerKind: "anthropic",
	baseUrl: "https://api.anthropic.com",
	model: "claude-opus-5-5",
	key: "sk-dry-run-before-ABCD",
};

test("every scripted task passes against the fake model, and the settings are restored", async ({
	request,
}) => {
	await apiLoginAs(request, "carol");
	const headers = { origin: WEB_ORIGIN };
	expect((await request.put("/admin/ai", { headers, data: BEFORE })).ok()).toBe(true);
	const notice = await request.post("/admin/ai/notice", {
		headers,
		data: { noticeVersion: 1 },
	});
	expect(notice.ok()).toBe(true);
	const on = await request.put("/admin/ai", { headers, data: { enabled: true } });
	expect(on.ok()).toBe(true);

	// MODEL_CHECK_ARGS passes --task or --provider through from make.
	const extra = (process.env.MODEL_CHECK_ARGS ?? "").split(" ").filter(Boolean);
	const code = await new Promise<number | null>((resolve) => {
		const child = spawn(
			join(root, "node_modules/.bin/tsx"),
			["scripts/model-check/run.ts", "--dry-run", ...extra],
			{
				cwd: root,
				stdio: "inherit",
				env: {
					...process.env,
					MODEL_CHECK_URL: WEB_ORIGIN,
					MODEL_CHECK_FAKE_MODEL_URL: `http://127.0.0.1:${FAKE_MODEL_PORT}`,
				},
			},
		);
		child.on("exit", resolve);
	});
	expect(code).toBe(0);

	const after = await (await request.get("/admin/ai")).json();
	expect(after).toMatchObject({
		enabled: true,
		providerKind: BEFORE.providerKind,
		baseUrl: BEFORE.baseUrl,
		model: BEFORE.model,
		keySet: true,
	});
});
