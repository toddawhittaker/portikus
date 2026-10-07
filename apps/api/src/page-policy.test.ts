import { DEX_PASSWORD_ROUTE } from "@portikus/auth";
import Fastify from "fastify";
import { expect, test } from "vitest";
import { previewPagePolicy, registerPagePolicy } from "./page-policy.js";

// SPEC.md section 24.3: HTML the API writes carries a full policy.
async function serve() {
	const app = Fastify();
	registerPagePolicy(app);
	app.get("/page", (_req, reply) =>
		reply.type("text/html; charset=utf-8").send("<p>hi</p>"),
	);
	app.get("/json", () => ({ ok: true }));
	app.get("/own", (_req, reply) =>
		reply
			.type("text/html")
			.header("content-security-policy", "sandbox")
			.send("<p>x</p>"),
	);
	app.post(DEX_PASSWORD_ROUTE, (_req, reply) =>
		reply.type("text/html").send("<p>dex</p>"),
	);
	await app.ready();
	return app;
}

test("an HTML page without a policy gets the full one", async () => {
	const app = await serve();
	const res = await app.inject({ url: "/page" });
	const policy = res.headers["content-security-policy"];
	expect(policy).toContain("default-src 'none'");
	expect(policy).toContain("frame-ancestors 'none'");
	expect(policy).not.toContain("script-src");
});

test("JSON, a page with its own policy, and the Dex relay are left alone", async () => {
	const app = await serve();
	expect(
		(await app.inject({ url: "/json" })).headers["content-security-policy"],
	).toBeUndefined();
	expect((await app.inject({ url: "/own" })).headers["content-security-policy"]).toBe(
		"sandbox",
	);
	const relayed = await app.inject({ method: "POST", url: "/dex/auth/local/login" });
	expect(relayed.headers["content-security-policy"]).toBeUndefined();
});

test("a preview page may be framed only by the control plane", () => {
	expect(previewPagePolicy("https://portikus.example.edu:8443/")).toBe(
		"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors https://portikus.example.edu:8443",
	);
});
