import { describe, expect, test } from "vitest";
import {
	deriveWorkspaceLabel,
	MAX_WORKSPACE_LABEL_LENGTH,
	Workspace,
} from "./workspace.js";

const HEX = "0a1b2c3d";

describe("deriveWorkspaceLabel", () => {
	test.each([
		["a plain username", "tw7", "tw7"],
		["uppercase", "TWhittaker", "twhittaker"],
		["a dot", "ada.lovelace", "ada-lovelace"],
		["an at sign and domain", "ada@school.edu", "ada-school-edu"],
		["spaces", "Ada  Lovelace", "ada-lovelace"],
		["an underscore", "ada_lovelace", "ada-lovelace"],
		["runs of punctuation", "ada+++lovelace", "ada-lovelace"],
		["existing hyphens kept", "ada-lovelace", "ada-lovelace"],
		["collapsed hyphen runs", "ada---lovelace", "ada-lovelace"],
		["leading and trailing junk", "--ada--", "ada"],
		["accented letters", "adá", "ad"],
		["a non-Latin script", "アダ-lovelace", "lovelace"],
	])("%s", (_name, input, expected) => {
		expect(deriveWorkspaceLabel(input, HEX)).toBe(expected);
	});

	test("falls back when the claim is missing", () => {
		expect(deriveWorkspaceLabel(null, HEX)).toBe("ws-0a1b2c3d");
		expect(deriveWorkspaceLabel(undefined, HEX)).toBe("ws-0a1b2c3d");
	});

	test("falls back when the claim reduces to nothing", () => {
		expect(deriveWorkspaceLabel("", HEX)).toBe("ws-0a1b2c3d");
		expect(deriveWorkspaceLabel("!!!", HEX)).toBe("ws-0a1b2c3d");
		expect(deriveWorkspaceLabel("---", HEX)).toBe("ws-0a1b2c3d");
		expect(deriveWorkspaceLabel("アダ", HEX)).toBe("ws-0a1b2c3d");
	});

	test("a digits-only username cannot be read as a port", () => {
		expect(deriveWorkspaceLabel("5173", HEX)).toBe("u5173");
		expect(deriveWorkspaceLabel("007", HEX)).toBe("u007");
	});

	test("a leading digit gets a letter in front", () => {
		expect(deriveWorkspaceLabel("7ada", HEX)).toBe("u7ada");
	});

	test("is capped at 40 characters", () => {
		const label = deriveWorkspaceLabel("a".repeat(100), HEX);
		expect(label).toHaveLength(MAX_WORKSPACE_LABEL_LENGTH);
		expect(label).toBe("a".repeat(MAX_WORKSPACE_LABEL_LENGTH));
	});

	test("never ends in a hyphen after the cap", () => {
		// The 40th character would be the hyphen if it were not trimmed.
		const label = deriveWorkspaceLabel(`${"a".repeat(39)}.b`, HEX);
		expect(label).toBe("a".repeat(39));
	});

	test("always produces a valid DNS label", () => {
		const inputs = [
			"tw7",
			"ada.lovelace",
			"",
			"---",
			"5173",
			"7ada",
			"a".repeat(100),
			"ADA@SCHOOL.EDU",
			"アダ",
			"a-".repeat(30),
		];
		for (const input of inputs) {
			const label = deriveWorkspaceLabel(input, HEX);
			expect(label).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
			expect(label.length).toBeGreaterThan(0);
			expect(label.length).toBeLessThanOrEqual(MAX_WORKSPACE_LABEL_LENGTH);
		}
	});
});

test("the Workspace contract carries the label", () => {
	const parsed = Workspace.safeParse({
		id: "22222222-2222-4222-8222-222222222222",
		ownerUserId: "11111111-1111-4111-8111-111111111111",
		label: "tw7",
		state: "running",
		desiredState: "running",
		incusInstanceName: "ws-abc",
		imageVersion: null,
		quotaConfig: { homeGiB: 25, dockerGiB: 20 },
		errorCode: null,
		errorMessage: null,
		activeConnections: 0,
		lastActiveConnectionAt: null,
		shutdownDeadline: null,
		archivedAt: null,
		createdAt: "2026-09-21T00:00:00.000Z",
		updatedAt: "2026-09-21T00:00:00.000Z",
	});
	expect(parsed.success).toBe(true);
});
