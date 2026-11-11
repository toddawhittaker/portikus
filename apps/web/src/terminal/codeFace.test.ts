import type { Terminal as Xterm } from "@xterm/xterm";
import { afterEach, expect, test, vi } from "vitest";
import { applyCodeFace } from "./useXterm.js";

function fakeTerm(): Xterm {
	return { options: {} } as unknown as Xterm;
}

function setFonts(fonts: Partial<FontFaceSet> | undefined) {
	Object.defineProperty(document, "fonts", { value: fonts, configurable: true });
}

afterEach(() => {
	setFonts(undefined);
});

test("a loaded code face is used at once and nothing waits", () => {
	const load = vi.fn();
	setFonts({ check: () => true, load });
	const term = fakeTerm();
	const refit = vi.fn();
	applyCodeFace(term, 14, refit);
	expect(term.options.fontFamily).toMatch(/^"JetBrains Mono", /);
	expect(load).not.toHaveBeenCalled();
	expect(refit).not.toHaveBeenCalled();
});

test("before the face loads the fallback is used, then the face and a refit", async () => {
	let loaded: () => void = () => {};
	setFonts({
		check: () => false,
		load: () =>
			new Promise<FontFace[]>((resolve) => {
				loaded = () => resolve([]);
			}),
	});
	const term = fakeTerm();
	const refit = vi.fn();
	applyCodeFace(term, 14, refit);
	expect(term.options.fontFamily).not.toContain("JetBrains Mono");
	loaded();
	await vi.waitFor(() => expect(refit).toHaveBeenCalledOnce());
	expect(term.options.fontFamily).toMatch(/^"JetBrains Mono", /);
});

test("a terminal closed before the face loads is left alone", async () => {
	let loaded: () => void = () => {};
	const pending = new Promise<FontFace[]>((resolve) => {
		loaded = () => resolve([]);
	});
	setFonts({ check: () => false, load: () => pending });
	const term = fakeTerm();
	const refit = vi.fn();
	const drop = applyCodeFace(term, 14, refit);
	drop();
	loaded();
	await pending;
	await Promise.resolve();
	expect(refit).not.toHaveBeenCalled();
	expect(term.options.fontFamily).not.toContain("JetBrains Mono");
});
