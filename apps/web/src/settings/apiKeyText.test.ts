/** How a key reads to its owner and to an administrator (SPEC.md section 24.13). */
import { expect, test } from "vitest";
import {
	canRenew,
	claudeCommand,
	expiryText,
	keyDay,
	lastUsedText,
	periodLabel,
	SCOPE_TEXT,
	SCOPES,
	STATE_TEXT,
} from "./apiKeyText.js";

test("a period reads in days, and no period reads as never expiring", () => {
	expect(periodLabel(7)).toBe("7 days");
	expect(periodLabel(30)).toBe("30 days");
	expect(periodLabel(null)).toBe("Never expires");
});

test("expiry names the day, says never, or says when the key was revoked", () => {
	const day = "2026-12-15T12:00:00.000Z";
	expect(expiryText({ expiresAt: null, revokedAt: null })).toBe("Never");
	expect(expiryText({ expiresAt: day, revokedAt: null })).toBe(keyDay(day));
	// Revoked wins over any expiry: the key stopped for good that day.
	expect(expiryText({ expiresAt: day, revokedAt: day })).toBe(`Revoked ${keyDay(day)}`);
});

test("last used says never for an unused key", () => {
	const now = Date.parse("2026-11-15T12:00:00.000Z");
	expect(lastUsedText(null, now)).toBe("Never used");
	expect(lastUsedText("2026-11-15T10:00:00.000Z", now)).toBe("2 hours ago");
});

test("active and expired keys renew; a revoked key never does", () => {
	expect(canRenew({ state: "active" })).toBe(true);
	expect(canRenew({ state: "expired" })).toBe(true);
	expect(canRenew({ state: "revoked" })).toBe(false);
});

test("only revoked reads as final; expired is a warning, not an ending", () => {
	expect(STATE_TEXT.revoked.tone).toBe("neutral");
	expect(STATE_TEXT.expired.tone).toBe("warning");
	expect(STATE_TEXT.active.tone).toBe("success");
});

test("every scope has a name and one sentence, in their order of power", () => {
	expect(SCOPES).toEqual(["read", "write", "destructive"]);
	for (const scope of SCOPES) {
		expect(SCOPE_TEXT[scope].detail).toMatch(/^[A-Z].*\.$/);
		expect(SCOPE_TEXT[scope].detail.split(". ")).toHaveLength(1);
	}
});

test("the Claude Code command points at this site's /mcp with the key as a bearer header", () => {
	expect(claudeCommand("https://portikus.example.edu", "portikus_abc")).toBe(
		'claude mcp add --transport http portikus https://portikus.example.edu/mcp --header "Authorization: Bearer portikus_abc"',
	);
});
