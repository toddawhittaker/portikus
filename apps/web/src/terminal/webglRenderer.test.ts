import type { Terminal } from "@xterm/xterm";
import { beforeEach, expect, test, vi } from "vitest";

const made: FakeAddon[] = [];
let failOnLoad = false;
let failOnConstruct = false;

class FakeAddon {
	disposed = 0;
	lose: (() => void) | undefined;
	constructor() {
		if (failOnConstruct) throw new Error("WebGL2 not supported");
		made.push(this);
	}
	onContextLoss = (listener: () => void) => {
		this.lose = listener;
		return { dispose() {} };
	};
	dispose() {
		this.disposed += 1;
	}
}

vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: FakeAddon }));

const { enableWebglRenderer } = await import("./webglRenderer.js");

function fakeTerm() {
	const loaded: unknown[] = [];
	const term = {
		loadAddon: vi.fn((addon: unknown) => {
			if (failOnLoad) throw new Error("no WebGL2 context");
			loaded.push(addon);
		}),
	};
	return { term: term as unknown as Terminal, loaded, loadAddon: term.loadAddon };
}

beforeEach(() => {
	made.length = 0;
	failOnLoad = false;
	failOnConstruct = false;
});

test("the addon is loaded into the open terminal", () => {
	const { term, loaded } = fakeTerm();
	enableWebglRenderer(term);
	expect(loaded).toEqual(made);
	expect(made[0]?.disposed).toBe(0);
});

test("a browser without WebGL2 stays on the DOM renderer without an error", () => {
	failOnLoad = true;
	const { term } = fakeTerm();
	expect(() => enableWebglRenderer(term)).not.toThrow();
	// The half-started addon is let go of.
	expect(made[0]?.disposed).toBe(1);
});

test("a constructor that throws also leaves the terminal on the DOM renderer", () => {
	failOnConstruct = true;
	const { term, loadAddon } = fakeTerm();
	expect(() => enableWebglRenderer(term)).not.toThrow();
	expect(loadAddon).not.toHaveBeenCalled();
});

test("a lost context disposes the addon once and does not try again", () => {
	const { term, loadAddon } = fakeTerm();
	const off = enableWebglRenderer(term);
	made[0]?.lose?.();
	expect(made[0]?.disposed).toBe(1);
	expect(loadAddon).toHaveBeenCalledTimes(1);
	// Closing the terminal afterwards does not dispose it a second time.
	off();
	expect(made[0]?.disposed).toBe(1);
	expect(made).toHaveLength(1);
});

test("closing the terminal disposes the addon, and only once", () => {
	const { term } = fakeTerm();
	const off = enableWebglRenderer(term);
	off();
	off();
	expect(made[0]?.disposed).toBe(1);
});

test("an addon that throws while being disposed does not break the cleanup", () => {
	const { term } = fakeTerm();
	const off = enableWebglRenderer(term);
	const addon = made[0];
	if (!addon) throw new Error("no addon");
	addon.dispose = () => {
		throw new Error("already gone");
	};
	expect(() => off()).not.toThrow();
});
