import { PassThrough, Readable } from "node:stream";
import { expect, test } from "vitest";
import { readableToWeb } from "./readable-to-web.js";

/** Let the web stream ask its source for data before the test acts. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i += 1) await null;
}

async function uncaughtDuring(run: () => Promise<void>): Promise<unknown[]> {
	const uncaught: unknown[] = [];
	const record = (error: unknown) => uncaught.push(error);
	process.on("uncaughtException", record);
	try {
		await run();
		await new Promise((resolve) => setTimeout(resolve, 20));
	} finally {
		process.off("uncaughtException", record);
	}
	return uncaught;
}

test("reads every chunk of the source", async () => {
	const web = readableToWeb(
		Readable.from([Buffer.from("hello "), Buffer.from("world")]),
	);
	expect(await new Response(web).text()).toBe("hello world");
});

test("a cancel while a read is pending destroys the source and throws nothing", async () => {
	const source = new PassThrough();
	source.write(Buffer.from("x".repeat(4000)));
	const uncaught = await uncaughtDuring(async () => {
		const web = readableToWeb(source);
		await settle();
		await web.cancel();
	});
	expect(uncaught).toEqual([]);
	expect(source.destroyed).toBe(true);
});

test("a cancel before any read throws nothing", async () => {
	const source = new PassThrough();
	source.write(Buffer.from("x"));
	const uncaught = await uncaughtDuring(async () => {
		await readableToWeb(source).cancel();
	});
	expect(uncaught).toEqual([]);
	expect(source.destroyed).toBe(true);
});

test("a source error reaches the reader", async () => {
	const source = new PassThrough();
	const reading = new Response(readableToWeb(source)).text();
	source.destroy(new Error("socket reset"));
	await expect(reading).rejects.toThrow();
});
