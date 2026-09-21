import { expect, test } from "vitest";
import {
	AgentCreateProjectRequest,
	AgentCreateTerminalRequest,
	AgentDuplicateProjectRequest,
	AgentError,
	AgentHealthResponse,
	AgentProjectList,
	AgentRenameProjectRequest,
	AgentTerminalList,
	StartInstanceRequest,
} from "./index.js";

const terminalId = "550e8400-e29b-41d4-a716-446655440000";

test("AgentHealthResponse accepts only ok true", () => {
	expect(AgentHealthResponse.parse({ ok: true })).toEqual({ ok: true });
	expect(AgentHealthResponse.safeParse({ ok: false }).success).toBe(false);
});

test("AgentTerminalList round-trips", () => {
	const input = {
		terminals: [{ id: terminalId, cwd: "/home/student", attachments: 2 }],
	};
	expect(AgentTerminalList.parse(input)).toEqual(input);
});

test("AgentCreateTerminalRequest requires an id, a cwd and a theme", () => {
	const input = { id: terminalId, cwd: "/home/student", theme: "light" };
	expect(AgentCreateTerminalRequest.parse(input)).toEqual(input);
	expect(AgentCreateTerminalRequest.safeParse({ cwd: "/home/student" }).success).toBe(
		false,
	);
	// The theme decides COLORFGBG in the shell (issue #267), so it is required.
	expect(
		AgentCreateTerminalRequest.safeParse({ id: terminalId, cwd: "/home/student" })
			.success,
	).toBe(false);
	expect(
		AgentCreateTerminalRequest.safeParse({ ...input, name: "shell" }).success,
	).toBe(false);
});

test("AgentError round-trips and rejects an unknown code", () => {
	const input = { error: { code: "TERMINAL_LIMIT" as const, message: "too many" } };
	expect(AgentError.parse(input)).toEqual(input);
	expect(AgentError.safeParse({ error: { code: "BOOM", message: "x" } }).success).toBe(
		false,
	);
});

test("StartInstanceRequest requires a 64-character hex agent token", () => {
	const token = "a".repeat(64);
	expect(
		StartInstanceRequest.parse({
			agentToken: token,
			hostname: "tw7",
			previewHostSuffix: "preview.portikus.school.edu",
		}),
	).toEqual({
		agentToken: token,
		hostname: "tw7",
		previewHostSuffix: "preview.portikus.school.edu",
		timeoutSeconds: 60,
	});
	expect(StartInstanceRequest.safeParse({}).success).toBe(false);
	expect(StartInstanceRequest.safeParse({ agentToken: "a".repeat(63) }).success).toBe(
		false,
	);
	expect(StartInstanceRequest.safeParse({ agentToken: "A".repeat(64) }).success).toBe(
		false,
	);
});

test("AgentProjectList round-trips and rejects a bad slug", () => {
	const input = { projects: [{ slug: "demo", isGitRepo: true }] };
	expect(AgentProjectList.parse(input)).toEqual(input);
	expect(
		AgentProjectList.safeParse({ projects: [{ slug: "Demo", isGitRepo: true }] })
			.success,
	).toBe(false);
});

test("AgentCreateProjectRequest requires an explicit gitInit", () => {
	expect(
		AgentCreateProjectRequest.parse({ slug: "demo", source: "new", gitInit: false }),
	).toEqual({ slug: "demo", source: "new", gitInit: false });
	expect(
		AgentCreateProjectRequest.safeParse({ slug: "demo", source: "new" }).success,
	).toBe(false);
	expect(
		AgentCreateProjectRequest.safeParse({
			slug: "demo",
			source: "clone",
			url: "file:///tmp/x",
			gitInit: false,
		}).success,
	).toBe(false);
	expect(
		AgentCreateProjectRequest.safeParse({
			slug: "demo",
			source: "new",
			gitInit: true,
			extra: 1,
		}).success,
	).toBe(false);
});

test("rename and duplicate take a target slug", () => {
	expect(AgentRenameProjectRequest.parse({ to: "renamed" })).toEqual({ to: "renamed" });
	expect(AgentDuplicateProjectRequest.parse({ to: "copy" })).toEqual({ to: "copy" });
	expect(AgentRenameProjectRequest.safeParse({ to: "../escape" }).success).toBe(false);
	expect(
		AgentDuplicateProjectRequest.safeParse({ to: "copy", from: "demo" }).success,
	).toBe(false);
});

test("AgentError accepts the project error codes", () => {
	for (const code of [
		"PROJECT_EXISTS",
		"PROJECT_NOT_FOUND",
		"INVALID_SLUG",
		"INVALID_URL",
		"GIT_FAILED",
	]) {
		expect(AgentError.safeParse({ error: { code, message: "no" } }).success).toBe(true);
	}
});

test("StartInstanceRequest requires a DNS-name preview host suffix", () => {
	const base = { agentToken: "a".repeat(64), hostname: "tw7" };
	// Missing, uppercase, and shell-metacharacter suffixes are all refused.
	expect(StartInstanceRequest.safeParse(base).success).toBe(false);
	expect(
		StartInstanceRequest.safeParse({ ...base, previewHostSuffix: "Preview.School.Edu" })
			.success,
	).toBe(false);
	expect(
		StartInstanceRequest.safeParse({ ...base, previewHostSuffix: "a.b; rm -rf /" })
			.success,
	).toBe(false);
	expect(
		StartInstanceRequest.safeParse({ ...base, previewHostSuffix: "preview.localhost" })
			.success,
	).toBe(true);
});
