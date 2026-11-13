import type { EffortLevel, PermissionMode } from "@anthropic-ai/claude-agent-sdk";

const EFFORTS: ReadonlySet<string> = new Set<EffortLevel>([
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

// `dontAsk` is left out: the chat's picker has never offered it.
const PERMISSION_MODES: ReadonlySet<string> = new Set<PermissionMode>([
	"default",
	"acceptEdits",
	"plan",
	"auto",
	"bypassPermissions",
]);

/** The SDK's effort for a chat value, or undefined so the SDK uses its default. */
export function toSdkEffort(effort: string): EffortLevel | undefined {
	return EFFORTS.has(effort) ? (effort as EffortLevel) : undefined;
}

/** The SDK's permission mode for a chat value, or undefined so the mode stays as it is. */
export function toSdkPermissionMode(mode: string): PermissionMode | undefined {
	return PERMISSION_MODES.has(mode) ? (mode as PermissionMode) : undefined;
}
