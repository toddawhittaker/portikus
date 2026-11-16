import type {
	ApiKey,
	ApiKeyPeriod,
	ApiKeyScope,
	ApiKeyState,
} from "@portikus/contracts";
import type { BadgeTone } from "@portikus/ui";
import { plural, timeAgo } from "../text.js";

/**
 * How API keys read on the owner's settings pane and the administrator's tab
 * (SPEC.md sections 24.8 and 24.13), so a key reads the same in both.
 */

/** Each scope's name and one plain sentence on what it allows. */
export const SCOPE_TEXT: Record<ApiKeyScope, { label: string; detail: string }> = {
	read: {
		label: "Read",
		detail:
			"Looks things up, such as accounts, workspaces, settings and audit events, and changes nothing.",
	},
	write: {
		label: "Write",
		detail:
			"Reads, and makes everyday changes such as starting a workspace or inviting a student.",
	},
	destructive: {
		label: "Destructive",
		detail:
			"Writes, and also takes actions that cannot be undone, such as deleting, resetting, or inviting an instructor or administrator.",
	},
};

export const SCOPES: readonly ApiKeyScope[] = ["read", "write", "destructive"];

/** Expired keys can still be renewed, so only revoked reads as final. */
export const STATE_TEXT: Record<ApiKeyState, { label: string; tone: BadgeTone }> = {
	active: { label: "Active", tone: "success" },
	expired: { label: "Expired", tone: "warning" },
	revoked: { label: "Revoked", tone: "neutral" },
};

/** "7 days", or "Never expires" for a key with no period. */
export function periodLabel(period: ApiKeyPeriod): string {
	return period === null ? "Never expires" : plural(period, "day");
}

/** A calendar day such as "Dec 15, 2026". */
export function keyDay(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

/** When the key stops or stopped working: "Never", "Dec 15, 2026", or the day it was revoked. */
export function expiryText(key: Pick<ApiKey, "expiresAt" | "revokedAt">): string {
	if (key.revokedAt !== null) return `Revoked ${keyDay(key.revokedAt)}`;
	return key.expiresAt === null ? "Never" : keyDay(key.expiresAt);
}

/** "Never used", or how long ago the key was last used. */
export function lastUsedText(iso: string | null, now: number): string {
	return iso === null ? "Never used" : timeAgo(iso, now);
}

/** Expired keys renew; revoked keys never do (SPEC.md section 24.13). */
export function canRenew(key: Pick<ApiKey, "state">): boolean {
	return key.state !== "revoked";
}

/** A ready-to-paste command that adds this site's MCP server to Claude Code. */
export function claudeCommand(origin: string, secret: string): string {
	return `claude mcp add --transport http portikus ${origin}/mcp --header "Authorization: Bearer ${secret}"`;
}
