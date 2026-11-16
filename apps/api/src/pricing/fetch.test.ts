/** Reading a pricing source (SPEC.md section 24.1): https only, capped, redirects checked. */
import { describe, expect, test } from "vitest";
import { fetchSource, SOURCE_MAX_BYTES } from "./fetch.js";

const SITE = {
	PUBLIC_URL: "https://portikus.school.edu",
	PREVIEW_SUFFIX: "preview.school.edu",
};

type Answer = { status: number; body?: string; location?: string };

function fakeOutbound(answers: Record<string, Answer>) {
	const seen: { url: string; redirect: unknown }[] = [];
	const outbound = async (url: string, init: RequestInit) => {
		seen.push({ url, redirect: init.redirect });
		const a = answers[url];
		if (!a) throw new Error("connection refused");
		return new Response(a.body ?? null, {
			status: a.status,
			headers: a.location ? { location: a.location } : {},
		});
	};
	return { outbound, seen };
}

describe("fetchSource", () => {
	test("returns the page and never lets fetch follow redirects itself", async () => {
		const { outbound, seen } = fakeOutbound({
			"https://openai.com/p": { status: 200, body: "<p>hi</p>" },
		});
		expect(await fetchSource("https://openai.com/p", { outbound, site: SITE })).toEqual(
			{
				ok: true,
				html: "<p>hi</p>",
			},
		);
		expect(seen[0]?.redirect).toBe("manual");
	});

	test("refuses plain http before any request", async () => {
		const { outbound, seen } = fakeOutbound({});
		expect(await fetchSource("http://openai.com/p", { outbound, site: SITE })).toEqual({
			ok: false,
			error: "refused",
		});
		expect(seen).toHaveLength(0);
	});

	test("a 403 is refused, a network failure unreachable", async () => {
		const { outbound } = fakeOutbound({ "https://a.openai.com/": { status: 403 } });
		expect(
			await fetchSource("https://a.openai.com/", { outbound, site: SITE }),
		).toEqual({
			ok: false,
			error: "refused",
		});
		expect(
			await fetchSource("https://b.openai.com/", { outbound, site: SITE }),
		).toEqual({
			ok: false,
			error: "unreachable",
		});
	});

	test("follows up to three https redirects and no more", async () => {
		const chain = (n: number) =>
			Object.fromEntries(
				Array.from({ length: n + 1 }, (_, i): [string, Answer] => [
					`https://openai.com/${i}`,
					i < n ? { status: 302, location: `/${i + 1}` } : { status: 200, body: "end" },
				]),
			) as Record<string, Answer>;
		expect(
			await fetchSource("https://openai.com/0", {
				outbound: fakeOutbound(chain(3)).outbound,
				site: SITE,
			}),
		).toEqual({ ok: true, html: "end" });
		expect(
			await fetchSource("https://openai.com/0", {
				outbound: fakeOutbound(chain(4)).outbound,
				site: SITE,
			}),
		).toEqual({ ok: false, error: "bad-redirect" });
	});

	test("a redirect to http is refused", async () => {
		const { outbound, seen } = fakeOutbound({
			"https://openai.com/p": { status: 301, location: "http://openai.com/p" },
		});
		expect(await fetchSource("https://openai.com/p", { outbound, site: SITE })).toEqual(
			{
				ok: false,
				error: "bad-redirect",
			},
		);
		expect(seen).toHaveLength(1);
	});

	test("a redirect to a private host, an IP address or this site itself is refused", async () => {
		for (const location of [
			"https://169.254.169.254/latest/meta-data",
			"https://localhost/p",
			"https://intranet/p",
			"https://portikus.school.edu/admin",
			"https://app-5173.preview.school.edu/p",
		]) {
			const { outbound, seen } = fakeOutbound({
				"https://openai.com/p": { status: 302, location },
				[location]: { status: 200, body: "secret" },
			});
			expect(
				await fetchSource("https://openai.com/p", { outbound, site: SITE }),
				location,
			).toEqual({ ok: false, error: "bad-redirect" });
			expect(seen.map((s) => s.url)).toEqual(["https://openai.com/p"]);
		}
	});

	test("a page over the size cap is refused", async () => {
		const { outbound } = fakeOutbound({
			"https://openai.com/big": { status: 200, body: "x".repeat(SOURCE_MAX_BYTES + 1) },
		});
		expect(
			await fetchSource("https://openai.com/big", { outbound, site: SITE }),
		).toEqual({
			ok: false,
			error: "too-large",
		});
	});

	test("a slow page times out", async () => {
		const outbound = (_url: string, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		expect(
			await fetchSource("https://openai.com/slow", {
				outbound,
				site: SITE,
				timeoutMs: 20,
			}),
		).toEqual({
			ok: false,
			error: "timeout",
		});
	});
});
