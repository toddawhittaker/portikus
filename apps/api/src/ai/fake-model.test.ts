import { expect, test } from "vitest";
import { createFakeModelClient } from "./fake-model.js";
import { ModelError, type ModelPart, type StepRequest } from "./model.js";

function request(signal = new AbortController().signal): StepRequest {
	return {
		system: "s",
		messages: [{ role: "user", text: "hi" }],
		tools: [],
		maxOutputTokens: 10,
		signal,
	};
}

async function collect(parts: AsyncIterable<ModelPart>): Promise<ModelPart[]> {
	const out: ModelPart[] = [];
	for await (const part of parts) out.push(part);
	return out;
}

const FINISH: ModelPart = {
	type: "finish",
	reason: "stop",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};

test("replays scripted steps in order and records each request", async () => {
	const first: ModelPart[] = [
		{ type: "tool-call", id: "1", name: "users_list", input: {} },
		FINISH,
	];
	const second: ModelPart[] = [{ type: "text", text: "Done." }, FINISH];
	const fake = createFakeModelClient([first, second]);
	const a = request();
	const b = request();
	expect(await collect(fake.step(a))).toEqual(first);
	expect(await collect(fake.step(b))).toEqual(second);
	expect(fake.requests).toEqual([a, b]);
});

test("throws a scripted error code as a ModelError", async () => {
	const fake = createFakeModelClient([{ error: "rate-limited" }]);
	await expect(collect(fake.step(request()))).rejects.toMatchObject({
		name: "ModelError",
		code: "rate-limited",
	});
});

test("an extra step past the script fails loudly", async () => {
	const fake = createFakeModelClient([]);
	await expect(collect(fake.step(request()))).rejects.toThrow("no step 1");
	expect(fake.requests).toHaveLength(1);
});

test("stops with aborted once the signal fires", async () => {
	const controller = new AbortController();
	const fake = createFakeModelClient([[{ type: "text", text: "a" }, FINISH]]);
	const seen: ModelPart[] = [];
	const run = async () => {
		for await (const part of fake.step(request(controller.signal))) {
			seen.push(part);
			controller.abort();
		}
	};
	await expect(run()).rejects.toBeInstanceOf(ModelError);
	expect(seen).toHaveLength(1);
});

test("listModels returns the scripted list", async () => {
	expect(await createFakeModelClient([], ["m1"]).listModels()).toEqual(["m1"]);
	expect(await createFakeModelClient([]).listModels()).toBeNull();
});
