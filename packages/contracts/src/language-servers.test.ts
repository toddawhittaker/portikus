import { expect, test } from "vitest";
import { CloseCode } from "./close-codes.js";
import {
	LANGUAGE_SERVER_MAX_DOCUMENT_BYTES,
	LANGUAGE_SERVER_MAX_FRAME_BYTES,
	LanguageServerId,
	MAX_LANGUAGE_SERVER_SOCKETS,
	MAX_LANGUAGE_SERVERS_PER_WORKSPACE,
} from "./language-servers.js";

test("LanguageServerId names python, typescript and ruff", () => {
	expect(LanguageServerId.options).toEqual(["python", "typescript", "ruff"]);
	expect(LanguageServerId.safeParse("clangd").success).toBe(false);
});

test("the limits are the ones the plan fixes", () => {
	expect(LANGUAGE_SERVER_MAX_FRAME_BYTES).toBe(4 * 1024 * 1024);
	expect(LANGUAGE_SERVER_MAX_DOCUMENT_BYTES).toBe(512 * 1024);
	expect(MAX_LANGUAGE_SERVER_SOCKETS).toBe(4);
	expect(MAX_LANGUAGE_SERVERS_PER_WORKSPACE).toBe(3);
});

test("the language-server close codes keep their numbers", () => {
	expect([
		CloseCode.LANGUAGE_SERVER_REPLACED,
		CloseCode.LANGUAGE_SERVER_IDLE,
		CloseCode.LANGUAGE_SERVER_CRASHED,
		CloseCode.LANGUAGE_SERVER_UNAVAILABLE,
		CloseCode.LANGUAGE_SERVER_DISABLED,
	]).toEqual([4412, 4413, 4414, 4415, 4416]);
});
