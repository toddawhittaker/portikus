import { describe, expect, test } from "vitest";
import { REPLAY_TURNS } from "../wire.js";
import type { AppServerClient } from "./app-server.js";
import { recentTurns } from "./history.js";

function answering(result: unknown) {
	const asked: { method: string; params: unknown }[] = [];
	const client = {
		request: async (method: string, params: unknown) => {
			asked.push({ method, params });
			return result;
		},
	} as unknown as AppServerClient;
	return { client, asked };
}

const turn = (id: string) => ({ id, status: "completed", items: [] });

describe("recentTurns", () => {
	test("asks for the newest page and returns it oldest first", async () => {
		const { client, asked } = answering({
			data: [turn("t3"), turn("t2")],
			nextCursor: null,
		});
		const page = await recentTurns(client, "thread-1");
		expect(asked).toEqual([
			{
				method: "thread/turns/list",
				params: {
					threadId: "thread-1",
					limit: REPLAY_TURNS,
					sortDirection: "desc",
					itemsView: "full",
				},
			},
		]);
		expect(page.turns.map((one) => one.id)).toEqual(["t2", "t3"]);
		expect(page.truncated).toBe(false);
	});

	test("a next cursor means older turns were left out", async () => {
		const { client } = answering({ data: [turn("t9")], nextCursor: "more" });
		expect((await recentTurns(client, "thread-1")).truncated).toBe(true);
	});

	test("no app-server, or a page that does not parse, reads as none", async () => {
		expect(await recentTurns(null, "thread-1")).toEqual({
			turns: [],
			truncated: false,
		});
		const { client } = answering({ unexpected: true });
		expect(await recentTurns(client, "thread-1")).toEqual({
			turns: [],
			truncated: false,
		});
	});
});
