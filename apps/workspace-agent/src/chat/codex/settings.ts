import { ChatEffort, ChatModelInfo, MAX_CHAT_MODELS } from "@portikus/contracts";
import type { ChatSettingsChange } from "../agent.js";
import type { CodexInput } from "./input.js";
import {
	type CodexModeId,
	isCodexMode,
	modePolicy,
	type SandboxPolicy,
} from "./modes.js";
import type { ModelList } from "./protocol.js";

/** The model, effort and permission mode the next turn runs with (SPEC.md §10.8). */
export interface Settings {
	model: string;
	effort: string;
	mode: CodexModeId;
}

export type Collaboration = "default" | "plan";

/** The models the picker offers, from the list Codex returned. */
export function modelInfos(list: ModelList): ChatModelInfo[] {
	const models: ChatModelInfo[] = [];
	for (const row of list.data) {
		if (row.hidden) continue;
		const efforts = (row.supportedReasoningEfforts ?? [])
			.map((each) => each.reasoningEffort)
			.filter((effort) => ChatEffort.safeParse(effort).success);
		const model = ChatModelInfo.safeParse({
			value: row.id,
			displayName: row.displayName.slice(0, 100),
			description: (row.description ?? "").slice(0, 300),
			supportsAutoMode: true,
			efforts: efforts.slice(0, 10),
			...(row.defaultReasoningEffort
				? { defaultEffort: row.defaultReasoningEffort }
				: {}),
		});
		if (model.success) models.push(model.data);
	}
	return models.slice(0, MAX_CHAT_MODELS);
}

/** The settings after a student's change, or an error saying why it is refused. */
export function changedSettings(
	settings: Settings,
	change: ChatSettingsChange,
	models: readonly ChatModelInfo[],
): Settings {
	const next = { ...settings };
	if (change.model !== undefined) {
		next.model = change.model;
		const info = models.find((row) => row.value === change.model);
		if (info?.efforts && !info.efforts.includes(next.effort)) {
			next.effort = info.defaultEffort ?? info.efforts[0] ?? next.effort;
		}
	}
	if (change.effort !== undefined) {
		const efforts = models.find((row) => row.value === next.model)?.efforts;
		if (efforts && !efforts.includes(change.effort)) {
			throw new Error("This model does not offer that effort.");
		}
		next.effort = change.effort;
	}
	if (change.mode !== undefined) {
		if (!isCodexMode(change.mode))
			throw new Error("Codex has no such permission mode.");
		next.mode = change.mode;
	}
	return next;
}

/** The parameters `thread/start` and `thread/resume` share. */
export function threadParams(
	projectDir: string,
	settings: Settings,
	workspace: SandboxPolicy,
) {
	const policy = modePolicy(settings.mode, workspace);
	return {
		cwd: projectDir,
		approvalPolicy: policy.approvalPolicy,
		sandbox: policy.sandbox,
		...(settings.model ? { model: settings.model } : {}),
	};
}

/**
 * The parameters of `turn/start`. The collaboration mode is sent only when
 * it differs from the one last sent, because Codex keeps it for later turns.
 */
export function turnStartParams(
	threadId: string | null,
	input: readonly CodexInput[],
	settings: Settings,
	workspace: SandboxPolicy,
	collaboration: Collaboration,
	sent: Collaboration,
) {
	const { model, effort, mode } = settings;
	const policy = modePolicy(mode, workspace);
	return {
		threadId,
		input,
		approvalPolicy: policy.approvalPolicy,
		sandboxPolicy: policy.sandboxPolicy,
		...(model ? { model } : {}),
		...(effort ? { effort } : {}),
		// A null leaves Codex's own text for the mode, and the platform's managed
		// developer instructions still apply.
		...(collaboration !== sent
			? {
					collaborationMode: {
						mode: collaboration,
						settings: {
							model,
							reasoning_effort: effort || null,
							developer_instructions: null,
						},
					},
				}
			: {}),
	};
}
