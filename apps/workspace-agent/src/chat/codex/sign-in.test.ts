import { describe, expect, test } from "vitest";
import type { AppServerClient } from "./app-server.js";
import { codexSignInUpdate, readCodexSignIn } from "./sign-in.js";

function answering(result: unknown): AppServerClient {
	return { request: async () => result } as unknown as AppServerClient;
}

describe("readCodexSignIn", () => {
	test("a provider that needs no OpenAI sign-in counts as signed in", async () => {
		expect(
			await readCodexSignIn(answering({ account: null, requiresOpenaiAuth: false })),
		).toBe("signedIn");
	});

	test("an API key account is signed in", async () => {
		expect(
			await readCodexSignIn(
				answering({ account: { type: "apiKey" }, requiresOpenaiAuth: true }),
			),
		).toBe("signedIn");
	});

	test("an answer it cannot read is unknown", async () => {
		expect(await readCodexSignIn(answering({ account: null }))).toBe("unknown");
		expect(await readCodexSignIn(answering(null))).toBe("unknown");
	});
});

describe("codexSignInUpdate", () => {
	test("reads the auth mode", () => {
		expect(codexSignInUpdate({ authMode: null })).toBe("signedOut");
		expect(codexSignInUpdate({ authMode: "apikey" })).toBe("signedIn");
		expect(codexSignInUpdate({})).toBeNull();
	});
});
