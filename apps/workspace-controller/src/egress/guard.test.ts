import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, test } from "vitest";

// packaging/egress-guard.sh, the helper unit's ExecStopPost (ADR 0038): it
// must fail closed whenever it cannot plainly read open mode.
const GUARD = fileURLToPath(
	new URL("../../../../packaging/egress-guard.sh", import.meta.url),
);

let dir: string;
let applied: string;
const dropAll = "/etc/portikus/egress-drop-all.nft";

function run(tableLoaded: boolean): { code: number; nft: string[] } {
	const log = join(dir, "nft.log");
	writeFileSync(log, "");
	const r = spawnSync("sh", [GUARD, applied, dropAll], {
		env: {
			PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
			NFT_LOG: log,
			TABLE_EXIT: tableLoaded ? "0" : "1",
		},
		encoding: "utf8",
	});
	return {
		code: r.status ?? -1,
		nft: readFileSync(log, "utf8").split("\n").filter(Boolean),
	};
}

/** What the helper writes, one line of JSON. */
function helperWrites(mode: "open" | "allow-list", blocked: string[] = []): string {
	return `${JSON.stringify({
		policy: {
			version: 3,
			mode,
			names: ["github.com"],
			ranges: [],
			ports: [443],
			blocked,
		},
		appliedAt: "2026-09-27T12:00:00.000Z",
		bridge: "portikus-ws",
		gateway: "10.200.0.1",
	})}\n`;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "egress-guard-"));
	mkdirSync(join(dir, "bin"));
	writeFileSync(
		join(dir, "bin", "nft"),
		'#!/bin/sh\necho "$*" >> "$NFT_LOG"\n[ "$1" = list ] && exit "$TABLE_EXIT"\nexit 0\n',
		{ mode: 0o755 },
	);
	applied = join(dir, "applied.json");
});

const DROP = `-f ${dropAll}`;

describe("the egress guard", () => {
	test("does nothing while the table is loaded", () => {
		writeFileSync(applied, helperWrites("allow-list"));
		expect(run(true)).toEqual({
			code: 0,
			nft: ["list table inet portikus_egress"],
		});
	});

	test("does nothing on a site that never applied a policy", () => {
		expect(run(false).nft).not.toContain(DROP);
	});

	test("does nothing when the last policy was open mode", () => {
		writeFileSync(applied, helperWrites("open"));
		expect(run(false).nft).not.toContain(DROP);
	});

	test("does nothing after open mode written before blocked sites existed", () => {
		writeFileSync(applied, helperWrites("open").replace(',"blocked":[]', ""));
		expect(run(false).nft).not.toContain(DROP);
	});

	test("drops forwarding when the last policy was open mode with blocked sites (ADR 0043)", () => {
		writeFileSync(applied, helperWrites("open", ["games.com"]));
		expect(run(false)).toEqual({
			code: 0,
			nft: ["list table inet portikus_egress", DROP],
		});
	});

	test("drops forwarding when the blocked list is named twice", () => {
		writeFileSync(
			applied,
			helperWrites("open").replace(
				'"blocked":[]',
				'"blocked":[],"x":{"blocked":["a.com"]}',
			),
		);
		expect(run(false).nft).toContain(DROP);
	});

	test("drops forwarding when the last policy was an allow-list", () => {
		writeFileSync(applied, helperWrites("allow-list"));
		expect(run(false)).toEqual({
			code: 0,
			nft: ["list table inet portikus_egress", DROP],
		});
	});

	test.each([
		["an empty file", ""],
		["a truncated file", helperWrites("open").slice(0, 60)],
		["two lines", `${helperWrites("open")}${helperWrites("open")}`],
		[
			"open mode named twice",
			helperWrites("open").replace('"names"', '"mode":"open","x"'),
		],
		[
			"a mode that only starts with open",
			helperWrites("open").replace('"open"', '"opener"'),
		],
		["no mode at all", '{"policy":{}}\n'],
	])("drops forwarding for %s", (_what, text) => {
		writeFileSync(applied, text);
		expect(run(false).nft).toContain(DROP);
	});

	test("drops forwarding when applied.json is a directory", () => {
		mkdirSync(applied);
		expect(run(false).nft).toContain(DROP);
	});

	test("drops forwarding when applied.json is a link to nowhere", () => {
		symlinkSync(join(dir, "missing"), applied);
		expect(run(false).nft).toContain(DROP);
	});

	test("fails loudly when the drop-all table does not load", () => {
		writeFileSync(applied, helperWrites("allow-list"));
		writeFileSync(
			join(dir, "bin", "nft"),
			'#!/bin/sh\necho "$*" >> "$NFT_LOG"\nexit 1\n',
			{ mode: 0o755 },
		);
		expect(run(false).code).not.toBe(0);
	});
});
