import type { Database } from "@portikus/db";
import Fastify from "fastify";
import type { Kysely } from "kysely";
import { describe, expect, test, vi } from "vitest";
import {
	ANONYMOUS_ROUTES,
	addressKey,
	check,
	createCounter,
	registerAnonymousLimit,
} from "./rate-limit.js";
import { ROUTE_POLICY } from "./security/route-policy.js";
import { registerSigninThrottle } from "./signin-throttle.js";
import { testConfig } from "./testing/test-support.js";

describe("the fixed-window counter (ADR 0034 ruling 15)", () => {
	function fixture(limit = 3, windowMs = 60_000) {
		let clock = 1_000_000;
		const counter = createCounter(limit, windowMs, () => clock);
		return { counter, advance: (ms: number) => (clock += ms) };
	}

	test("lets the limit through and refuses the next one, for that key only", () => {
		const { counter } = fixture();
		for (let i = 0; i < 3; i++) expect(check(counter, "u1").allowed).toBe(true);
		expect(check(counter, "u1").allowed).toBe(false);
		expect(check(counter, "u2").allowed).toBe(true);
	});

	test("reports the first refusal of a window once", () => {
		const { counter } = fixture(1);
		check(counter, "u1");
		expect(check(counter, "u1").firstRefusal).toBe(true);
		expect(check(counter, "u1").firstRefusal).toBe(false);
	});

	test("says how long until the window ends", () => {
		const { counter, advance } = fixture(1);
		check(counter, "u1");
		advance(15_500);
		expect(check(counter, "u1").retryAfterSeconds).toBe(45);
		advance(44_000);
		expect(check(counter, "u1").retryAfterSeconds).toBe(1);
	});

	test("a new window starts afresh", () => {
		const { counter, advance } = fixture(1);
		check(counter, "u1");
		expect(check(counter, "u1").allowed).toBe(false);
		advance(60_000);
		expect(check(counter, "u1")).toEqual({
			allowed: true,
			firstRefusal: false,
			retryAfterSeconds: 0,
		});
	});

	test("drops the windows of keys that have gone quiet, so memory stays bounded", () => {
		const { counter, advance } = fixture();
		for (let i = 0; i < 1000; i++) check(counter, `u${i}`);
		expect(counter.size()).toBe(1000);
		advance(60_000);
		check(counter, "fresh");
		expect(counter.size()).toBe(1);
	});

	test("a preview page of 2,000 assets fits one window; a runaway loop does not", () => {
		const { counter } = fixture(2000, 10_000);
		for (let i = 0; i < 2000; i++) expect(check(counter, "s").allowed).toBe(true);
		expect(check(counter, "s").allowed).toBe(false);
	});
});

describe("addressKey (SPEC.md section 24.13)", () => {
	test("keeps an IPv4 address, also when IPv6-mapped", () => {
		expect(addressKey("198.51.100.7")).toBe("198.51.100.7");
		expect(addressKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
	});

	test("reduces every IPv6 spelling to its /64", () => {
		const key = "2001:db8:0:12::/64";
		expect(addressKey("2001:db8:0:12::1")).toBe(key);
		expect(addressKey("2001:0DB8:0000:0012:ffff:1:2:3")).toBe(key);
		expect(addressKey("2001:db8::12:0:0:0:1")).toBe(key);
		expect(addressKey("2001:db8:0:13::1")).not.toBe(key);
		expect(addressKey("::1")).toBe("0:0:0:0::/64");
	});
});

describe("the anonymous request limit (SPEC.md section 24.13)", () => {
	test("covers every public route except the certificate ask, which has no client address", () => {
		const publicRoutes = Object.entries(ROUTE_POLICY)
			.filter(([, policy]) => policy.access === "public")
			.map(([route]) => route)
			.filter((route) => !route.endsWith(" /edge/certificate-ask"));
		expect([...ANONYMOUS_ROUTES].sort()).toEqual(publicRoutes.sort());
	});

	function fixture(limit = 3) {
		const config = testConfig("http://issuer.invalid", {
			ANONYMOUS_REQUEST_LIMIT_PER_MINUTE: limit,
		});
		const app = Fastify({ trustProxy: "127.0.0.1" });
		registerAnonymousLimit(app, config);
		const throttle = registerSigninThrottle(app, {
			db: {} as Kysely<Database>,
			config,
		});
		app.get("/auth/login", async () => "ok");
		app.get("/lti/jwks", async () => "ok");
		app.get("/auth/me", async () => "ok");
		return { app, throttle };
	}

	test("refuses one address past the limit with 429 RATE_LIMITED and retry-after", async () => {
		const { app } = fixture();
		for (let i = 0; i < 3; i += 1) {
			const ok = await app.inject({ url: "/lti/jwks", remoteAddress: "203.0.113.1" });
			expect(ok.statusCode).toBe(200);
		}
		const refused = await app.inject({
			url: "/lti/jwks",
			remoteAddress: "203.0.113.1",
		});
		expect(refused.statusCode).toBe(429);
		expect(refused.json()).toMatchObject({ code: "RATE_LIMITED" });
		expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
		const other = await app.inject({ url: "/lti/jwks", remoteAddress: "203.0.113.2" });
		expect(other.statusCode).toBe(200);
	});

	test("counts an IPv6 /64 as one address", async () => {
		const { app } = fixture(1);
		await app.inject({ url: "/lti/jwks", remoteAddress: "2001:db8:1:2::a" });
		const refused = await app.inject({
			url: "/lti/jwks",
			remoteAddress: "2001:db8:1:2:ffff::b",
		});
		expect(refused.statusCode).toBe(429);
	});

	test("leaves routes that need a session alone", async () => {
		const { app } = fixture(1);
		for (let i = 0; i < 5; i += 1) {
			const res = await app.inject({ url: "/auth/me", remoteAddress: "203.0.113.1" });
			expect(res.statusCode).toBe(200);
		}
	});

	test("a refused request makes no sign-in count", async () => {
		const { app, throttle } = fixture(2);
		const checkStart = vi.spyOn(throttle, "checkStart");
		for (let i = 0; i < 2; i += 1) {
			await app.inject({ url: "/auth/login", remoteAddress: "203.0.113.1" });
		}
		expect(checkStart).toHaveBeenCalledTimes(2);
		const refused = await app.inject({
			url: "/auth/login",
			remoteAddress: "203.0.113.1",
		});
		expect(refused.statusCode).toBe(429);
		expect(checkStart).toHaveBeenCalledTimes(2);
	});
});
