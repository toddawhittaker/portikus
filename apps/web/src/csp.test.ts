import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, type Plugin } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import viteConfig from "../vite.config.js";
import {
	contentSecurityPolicy,
	contentSecurityPolicyPlugin,
	withContentSecurityPolicy,
} from "./csp.js";

/** The policy as a map from directive to its sources. */
function directives(policy: string): Map<string, string[]> {
	return new Map(
		policy.split("; ").map((part) => {
			const [name = "", ...sources] = part.split(" ");
			return [name, sources];
		}),
	);
}

describe("the control-plane content security policy (SPEC.md section 24.3)", () => {
	it("allows scripts from this origin only, never inline or eval", () => {
		const policy = directives(contentSecurityPolicy());
		expect(policy.get("script-src")).toEqual(["'self'"]);
		expect(policy.get("worker-src")).toEqual(["'self'"]);
		expect(policy.get("default-src")).toEqual(["'self'"]);
		expect(policy.get("object-src")).toEqual(["'none'"]);
		expect(policy.get("base-uri")).toEqual(["'self'"]);
		expect(policy.get("form-action")).toEqual(["'self'"]);
	});

	it("leaves out frame-ancestors, which a meta tag cannot carry", () => {
		expect(directives(contentSecurityPolicy()).has("frame-ancestors")).toBe(false);
	});

	it("allows an inline script only by the hash of its exact text", () => {
		const html = withContentSecurityPolicy(
			'<html><head><script type="module">alert(1)</script><script type="module" src="/a.js"></script></head></html>',
		);
		const content = /content="([^"]+)"/.exec(html)?.[1] ?? "";
		expect(directives(content).get("script-src")).toEqual([
			"'self'",
			"'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='",
		]);
	});

	it("puts the policy before anything else in the head", () => {
		const html = withContentSecurityPolicy(
			"<html><head><script>x()</script><title>t</title></head></html>",
		);
		expect(html.indexOf("Content-Security-Policy")).toBeLessThan(
			html.indexOf("<script"),
		);
	});

	it("is registered in the web app's Vite config", () => {
		const names = (viteConfig.plugins ?? [])
			.flat()
			.map((plugin) => (plugin as Plugin | null)?.name);
		expect(names).toContain(contentSecurityPolicyPlugin().name);
	});
});

describe("a Vite build with the plugin", () => {
	const root = mkdtempSync(join(tmpdir(), "portikus-csp-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("writes the production policy, with no hashes, into the built index.html", async () => {
		writeFileSync(
			join(root, "index.html"),
			'<!doctype html><html><head><meta charset="UTF-8" /><title>t</title></head><body><script type="module" src="/main.js"></script></body></html>',
		);
		writeFileSync(join(root, "main.js"), "document.title = 'built';\n");
		const output = await build({
			root,
			configFile: false,
			logLevel: "silent",
			plugins: [contentSecurityPolicyPlugin()],
			build: { write: false, outDir: join(root, "dist") },
		});
		const bundles = Array.isArray(output) ? output : [output];
		const page = bundles
			.flatMap((bundle) => ("output" in bundle ? bundle.output : []))
			.find((file) => file.fileName === "index.html");
		const html = page && "source" in page ? String(page.source) : "";
		expect(html).toContain(
			`<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy()}" />`,
		);
	});
});

describe("Zod's eval probe is off before the app loads", () => {
	const page = readFileSync(join(import.meta.dirname, "../index.html"), "utf8");
	const script = readFileSync(
		join(import.meta.dirname, "../public/zod-jitless.js"),
		"utf8",
	);

	it("sets the global Zod reads its config from", () => {
		const global = globalThis as { __zod_globalConfig?: unknown };
		expect(z.config()).toBe(global.__zod_globalConfig);
		expect(script).toContain("globalThis.__zod_globalConfig = { jitless: true };");
	});

	it("is a classic script ahead of the app's module script", () => {
		const probe = page.indexOf('<script defer src="/zod-jitless.js"></script>');
		expect(probe).toBeGreaterThan(-1);
		expect(probe).toBeLessThan(page.indexOf('<script type="module"'));
	});
});
