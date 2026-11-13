import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { ChatMcpServer, MAX_CHAT_MCP_SERVERS } from "@portikus/contracts";
import { expect, test, vi } from "vitest";
import { chatMcpServers, ELICITATION_NOTICE, refreshMcp } from "./mcp-status.js";

const row = (name: string, status: McpServerStatus["status"]): McpServerStatus => ({
	name,
	status,
});

test("each SDK status becomes the chat's word for it", () => {
	expect(
		chatMcpServers([
			row("a", "connected"),
			row("b", "pending"),
			row("c", "failed"),
			row("d", "needs-auth"),
			row("e", "disabled"),
		]),
	).toEqual([
		{ name: "a", status: "connected" },
		{ name: "b", status: "starting" },
		{ name: "c", status: "failed" },
		{ name: "d", status: "needsAuth" },
		{ name: "e", status: "disabled" },
	]);
});

test("names and statuses only: no URL, tools, error or server info", () => {
	const [server] = chatMcpServers([
		{
			name: "docs",
			status: "failed",
			error: "connect ECONNREFUSED 10.0.0.1",
			config: { type: "http", url: "https://secret.example" },
			serverInfo: { name: "docs", version: "1" },
			tools: [{ name: "search" }],
			scope: "user",
		},
	]);
	expect(server).toStrictEqual({ name: "docs", status: "failed" });
});

test("a row the contract refuses or a status it does not know is left out, and the list is capped", () => {
	const unknown = { name: "x", status: "weird" } as unknown as McpServerStatus;
	expect(
		chatMcpServers([row("", "connected"), row("n".repeat(65), "connected"), unknown]),
	).toEqual([]);
	const many = Array.from({ length: MAX_CHAT_MCP_SERVERS + 5 }, (_, i) =>
		row(`s${i}`, "connected"),
	);
	const listed = chatMcpServers(many);
	expect(listed).toHaveLength(MAX_CHAT_MCP_SERVERS);
	for (const server of listed)
		expect(ChatMcpServer.safeParse(server).success).toBe(true);
});

test("a read tells the list; a failed read or a replaced session tells nothing", async () => {
	const told = vi.fn();
	expect(
		await refreshMcp(
			async () => [row("a", "connected")],
			() => true,
			told,
		),
	).toBe(true);
	expect(told).toHaveBeenCalledWith([{ name: "a", status: "connected" }]);
	told.mockClear();
	expect(
		await refreshMcp(
			async () => {
				throw new Error("unsupported");
			},
			() => true,
			told,
		),
	).toBe(false);
	expect(
		await refreshMcp(
			async () => [row("a", "connected")],
			() => false,
			told,
		),
	).toBe(false);
	expect(told).not.toHaveBeenCalled();
});

test("the elicitation notice names the terminal", () => {
	expect(ELICITATION_NOTICE).toBe(
		"An MCP server asked for input. Use a terminal tab to answer it.",
	);
});
