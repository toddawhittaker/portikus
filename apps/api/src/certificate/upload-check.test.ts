/**
 * The API's upload checks (SPEC.md 20.1, 24.8): each refusal names the
 * check that failed, and no message quotes the upload.
 */
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { checkUpload } from "./upload-check.js";

const SITE = "portikus.example.edu";
const WILDCARD = "*.preview.example.edu";

let dir: string;
const pem: Record<string, string> = {};

function openssl(...args: string[]) {
	execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
}

function newKey(name: string) {
	openssl(
		"genpkey",
		"-algorithm",
		"EC",
		"-pkeyopt",
		"ec_paramgen_curve:P-256",
		"-out",
		`${name}.key`,
	);
}

/** A leaf for `names`, signed by `issuer`. */
function leaf(name: string, issuer: string, names: string[]) {
	newKey(name);
	openssl(
		"req",
		"-new",
		"-key",
		`${name}.key`,
		"-subj",
		`/CN=${names[0]}`,
		"-out",
		`${name}.csr`,
	);
	writeFileSync(
		join(dir, `${name}.ext`),
		`subjectAltName=${names.map((n) => `DNS:${n}`).join(",")}\n`,
	);
	openssl(
		"x509",
		"-req",
		"-in",
		`${name}.csr`,
		"-CA",
		`${issuer}.crt`,
		"-CAkey",
		`${issuer}.key`,
		"-CAcreateserial",
		"-days",
		"30",
		"-extfile",
		`${name}.ext`,
		"-out",
		`${name}.crt`,
	);
}

function read(name: string) {
	return readFileSync(join(dir, name), "utf8");
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "portikus-upload-"));
	for (const ca of ["root", "other-root"]) {
		newKey(ca);
		openssl(
			"req",
			"-x509",
			"-key",
			`${ca}.key`,
			"-subj",
			`/CN=Test ${ca}`,
			"-days",
			"30",
			"-addext",
			"basicConstraints=critical,CA:TRUE",
			"-addext",
			"keyUsage=critical,keyCertSign",
			"-out",
			`${ca}.crt`,
		);
	}
	leaf("both", "root", [SITE, WILDCARD]);
	leaf("site-only", "root", [SITE]);
	leaf("stranger", "other-root", [SITE, WILDCARD]);
	for (const name of ["root", "both", "site-only", "stranger"]) {
		pem[name] = read(`${name}.crt`);
		pem[`${name}.key`] = read(`${name}.key`);
	}
}, 30_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const now = () => new Date();
const trusted = () => [new X509Certificate(pem.root as string)];

describe("checkUpload", () => {
	test("accepts a matching key and a chain to a trusted root", () => {
		const upload = { certificate: pem.both as string, privateKey: pem["both.key"] };
		expect(checkUpload(upload, [SITE, WILDCARD], now(), trusted())).toBeNull();
	});

	test("accepts a chain that includes its own self-signed root", () => {
		const upload = {
			certificate: `${pem.both}${pem.root}`,
			privateKey: pem["both.key"],
		};
		expect(checkUpload(upload, [SITE], now(), [])).toBeNull();
	});

	test("certificate-readable: text that is not a certificate", () => {
		const upload = {
			certificate: "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n",
		};
		expect(checkUpload(upload, [SITE], now(), trusted())?.check).toBe(
			"certificate-readable",
		);
	});

	test("key-readable: a key that does not parse", () => {
		const upload = {
			certificate: pem.both as string,
			// Built in pieces so the secret scanner does not take the fake for a key.
			privateKey: `-----BEGIN ${["PRIVATE", "KEY"].join(" ")}-----\nAAAA\n-----END ${["PRIVATE", "KEY"].join(" ")}-----\n`,
		};
		expect(checkUpload(upload, [SITE], now(), trusted())?.check).toBe("key-readable");
	});

	test("key-matches: another certificate's key", () => {
		const upload = {
			certificate: pem.both as string,
			privateKey: pem["site-only.key"],
		};
		const refusal = checkUpload(upload, [SITE], now(), trusted());
		expect(refusal?.check).toBe("key-matches");
		expect(refusal?.message).not.toContain("PRIVATE KEY");
	});

	test("chain-complete: an issuer that is neither included nor trusted", () => {
		const upload = {
			certificate: pem.stranger as string,
			privateKey: pem["stranger.key"],
		};
		expect(checkUpload(upload, [SITE], now(), trusted())?.check).toBe("chain-complete");
	});

	test("dates-valid: checked after the certificate has expired", () => {
		const later = new Date(Date.now() + 365 * 86_400_000);
		const upload = { certificate: pem.both as string, privateKey: pem["both.key"] };
		expect(checkUpload(upload, [SITE], later, trusted())?.check).toBe("dates-valid");
	});

	test("names-cover: no preview wildcard", () => {
		const upload = {
			certificate: pem["site-only"] as string,
			privateKey: pem["site-only.key"],
		};
		const refusal = checkUpload(upload, [SITE, WILDCARD], now(), trusted());
		expect(refusal?.check).toBe("names-cover");
		expect(refusal?.message).toContain(WILDCARD);
	});

	test("an omitted key keeps the stored one and skips the key checks", () => {
		expect(
			checkUpload({ certificate: pem.both as string }, [SITE], now(), trusted()),
		).toBeNull();
	});
});
