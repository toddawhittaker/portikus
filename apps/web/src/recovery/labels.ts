/** How a recovery point is named to the student (SPEC.md §15). */
import type { RecoveryReason } from "@portikus/contracts";

export const REASON_LABEL: Record<RecoveryReason, string> = {
	periodic: "Every 15 minutes",
	manual: "Made by you",
	"before-archive": "Before archive",
	"before-restore": "Before restore",
	"before-rebuild": "Before rebuild",
	"agent-session": "Before Claude Code or Codex session",
	"before-replace-home": "Before home folder replaced",
};

/** The point's time in the student's own locale and time zone. */
export function pointTime(createdAt: string): string {
	return new Date(createdAt).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}
