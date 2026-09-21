import { parsePreviewHost, previewHost } from "@portikus/contracts";
import { expect, test } from "vitest";
import { testConfig } from "../test-support.js";
import { portAllowed, requestHost } from "./policy.js";

/**
 * A property test over hostile hostnames (BROWSER-HANDLING.md §8, §25.1,
 * §26). The rule the parser must never break: for any string at all,
 * `parsePreviewHost` either refuses it or returns a label and port that
 * rebuild exactly the name it was given. Anything else would mean a name
 * the gateway routes one way and the control plane reads another.
 */

const SUFFIX = "preview.portikus.school.edu";
const CASES = 4000;

/** A small deterministic generator, so a failure can be reproduced. */
function makeRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

const random = makeRandom(20260921);

function pick<T>(items: readonly T[]): T {
	return items[Math.floor(random() * items.length)] as T;
}

/** Characters chosen to hit every rule the parser has, and a few it has not. */
const CHARS = [
	..."abcdefghijklmnopqrstuvwxyz",
	..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
	..."0123456789",
	"-",
	"-",
	".",
	"_",
	":",
	"@",
	"/",
	"+",
	"%",
	" ",
	"\t",
	"\n",
	"\u0000",
	"é",
	"е", // Cyrillic e
	"０", // full-width zero
	"٠", // Arabic-Indic zero
	"​", // zero-width space
	"․", // one-dot leader
];

function randomString(maxLength: number): string {
	const length = Math.floor(random() * maxLength);
	let out = "";
	for (let i = 0; i < length; i += 1) out += pick(CHARS);
	return out;
}

const PORT_SHAPES = [
	() => String(Math.floor(random() * 70000)),
	() => `0${Math.floor(random() * 9999)}`,
	() => `0x${Math.floor(random() * 65535).toString(16)}`,
	() => `0o${Math.floor(random() * 777).toString(8)}`,
	() => `${Math.floor(random() * 65535)}e3`,
	() => `+${Math.floor(random() * 65535)}`,
	() => `-${Math.floor(random() * 65535)}`,
	() => `${Math.floor(random() * 65535)}.0`,
	() => String(Number.MAX_SAFE_INTEGER + Math.floor(random() * 1000)),
	() => "٥١٧٣",
	() => "",
	() => randomString(8),
];

const LABEL_SHAPES = [
	() => `ws-${Math.floor(random() * 1e8).toString(36)}`,
	() => `-${randomString(6)}`,
	() => `${randomString(6)}-`,
	() => `xn--${randomString(8)}`,
	() => "a".repeat(1 + Math.floor(random() * 70)),
	() => randomString(12),
	() => "127.0.0.1",
	() => "[::1]",
	() => "localhost",
	() => "",
];

const WRAPPERS = [
	(host: string) => host,
	(host: string) => `${host}.`,
	(host: string) => `${host}:${Math.floor(random() * 70000)}`,
	(host: string) => `https://${host}`,
	(host: string) => `user:pass@${host}`,
	(host: string) => `${host}/admin`,
	(host: string) => host.toUpperCase(),
	(host: string) => ` ${host} `,
	(host: string) => `extra.${host}`,
	(host: string) => `${host}${SUFFIX}`,
];

/** One hostile candidate: a label, a port shape, a suffix, and a wrapper. */
function candidate(): string {
	const label = pick(LABEL_SHAPES)();
	const port = pick(PORT_SHAPES)();
	const suffix = pick([
		SUFFIX,
		`${SUFFIX}.evil.example`,
		`not${SUFFIX}`,
		"preview.localhost",
		randomString(10),
		"",
	]);
	const base = suffix === "" ? `${label}-${port}` : `${label}-${port}.${suffix}`;
	return pick(WRAPPERS)(base);
}

test("every parse either refuses or round-trips exactly", () => {
	const config = testConfig("http://127.0.0.1:3002", {
		PREVIEW_SUFFIX: SUFFIX,
	});
	for (let i = 0; i < CASES; i += 1) {
		const host = candidate();
		const parsed = parsePreviewHost(host, SUFFIX);
		if (parsed === null) continue;

		// Accepted: the pair must rebuild the name, case-folded, and nothing
		// else. A gateway routing `host` and a control plane reading
		// `parsed` must be talking about the same workspace and port.
		expect(previewHost(parsed.label, parsed.port, SUFFIX), host).toBe(
			host.toLowerCase(),
		);
		expect(parsed.port, host).toBeGreaterThanOrEqual(1);
		expect(parsed.port, host).toBeLessThanOrEqual(65535);
		expect(parsed.label, host).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
		expect(parsed.label.length, host).toBeLessThanOrEqual(63);
		// A port the parser accepts is still only a name: policy decides.
		expect(typeof portAllowed(config, parsed.port)).toBe("boolean");
	}
});

test("a real preview host always survives the round trip", () => {
	for (let i = 0; i < 500; i += 1) {
		const label = `ws-${Math.floor(random() * 1e12).toString(36)}`;
		const port = 1 + Math.floor(random() * 65535);
		const host = previewHost(label, port, SUFFIX);
		expect(parsePreviewHost(host, SUFFIX)).toEqual({ label, port });
	}
});

test("what requestHost hands the parser is never a surprise", () => {
	for (let i = 0; i < CASES; i += 1) {
		const value = candidate();
		const host = requestHost({ host: value });
		if (host === null) continue;
		// requestHost promises a bare name: lower case, no port, no userinfo.
		expect(host, value).toBe(host.toLowerCase());
		expect(host.includes(":"), value).toBe(false);
		expect(host.includes("@"), value).toBe(false);
		const parsed = parsePreviewHost(host, SUFFIX);
		if (parsed === null) continue;
		expect(previewHost(parsed.label, parsed.port, SUFFIX), value).toBe(host);
	}
});

test("an array of Host headers cannot smuggle a second name", () => {
	const good = previewHost("ws-1234abcd", 5173, SUFFIX);
	// Node gives duplicated headers as an array; only the first is read.
	expect(requestHost({ host: [good, "evil.example"] })).toBe(good);
	expect(
		requestHost({ "x-forwarded-host": [good, "evil.example"], host: "other" }),
	).toBe(good);
	expect(requestHost({ host: [] })).toBeNull();
	expect(requestHost({})).toBeNull();
});

test("no address literal is ever read as a preview host", () => {
	const literals = [
		"127.0.0.1",
		"127.1",
		"0x7f000001",
		"2130706433",
		"0177.0.0.1",
		"169.254.169.254",
		"[::1]",
		"[fe80::1]",
		"::1",
		"[::ffff:127.0.0.1]",
		"10.0.0.1",
		"metadata.google.internal",
	];
	for (const literal of literals) {
		expect(parsePreviewHost(literal, SUFFIX), literal).toBeNull();
		expect(parsePreviewHost(`${literal}.${SUFFIX}`, SUFFIX), literal).toBeNull();
	}
});
