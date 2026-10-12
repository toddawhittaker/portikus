/**
 * The mock over https, as the rehearsal runs it: a leaf certificate signed
 * by a root the client trusts, and the tool's keyset read from a file, so
 * roster sync's token request is checked over TLS like a real platform's.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { request } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NRPS_SCOPE } from "./roster.js";
import { CLIENT_ID } from "./seed.js";
import { createListener, type Handler } from "./serve.js";
import { createHandler } from "./server.js";
import { createSigner } from "./token.js";
import { keysFromFile } from "./tool.js";

const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

let dir: string;
let ca: Buffer;
let server: Server;
let base: string;
let toolKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

function openssl(...args: string[]) {
	execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "mock-lms-tls-"));
	// A root, then a leaf for 127.0.0.1 signed by it: the shape lti.sh makes with the VM's Caddy root.
	openssl(
		"req",
		"-x509",
		"-newkey",
		"ec",
		"-pkeyopt",
		"ec_paramgen_curve:prime256v1",
		"-nodes",
		"-keyout",
		"root.key",
		"-out",
		"root.crt",
		"-days",
		"1",
		"-subj",
		"/CN=test root",
	);
	openssl(
		"req",
		"-new",
		"-newkey",
		"ec",
		"-pkeyopt",
		"ec_paramgen_curve:prime256v1",
		"-nodes",
		"-keyout",
		"mock.key",
		"-out",
		"mock.csr",
		"-subj",
		"/CN=mock LMS",
		"-addext",
		"subjectAltName=IP:127.0.0.1",
	);
	openssl(
		"x509",
		"-req",
		"-in",
		"mock.csr",
		"-CA",
		"root.crt",
		"-CAkey",
		"root.key",
		"-CAcreateserial",
		"-days",
		"1",
		"-copy_extensions",
		"copy",
		"-out",
		"mock.crt",
	);
	ca = readFileSync(join(dir, "root.crt"));

	const pair = await generateKeyPair("RS256");
	toolKey = pair.privateKey;
	writeFileSync(
		join(dir, "jwks.json"),
		JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "tool-1" }] }),
	);

	// The issuer names the port, which is known only once the server listens.
	let handler: Handler | undefined;
	server = createListener(async (req, res) => handler?.(req, res), {
		certFile: join(dir, "mock.crt"),
		keyFile: join(dir, "mock.key"),
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
	handler = createHandler({
		issuer: base,
		toolUrl: "https://tool.invalid",
		signer: await createSigner(),
		log: () => {},
		fetchToolKeys: keysFromFile(join(dir, "jwks.json")),
	});
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
	rmSync(dir, { recursive: true, force: true });
});

function call(
	path: string,
	options: { ca?: Buffer; form?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const body = options.form
			? new URLSearchParams(options.form).toString()
			: undefined;
		const req = request(
			`${base}${path}`,
			{
				method: body === undefined ? "GET" : "POST",
				...(options.ca ? { ca: options.ca } : {}),
				headers:
					body === undefined
						? {}
						: { "content-type": "application/x-www-form-urlencoded" },
			},
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					text += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
			},
		);
		req.on("error", reject);
		req.end(body);
	});
}

describe("the mock over https", () => {
	it("serves its keyset to a client that trusts the signing root", async () => {
		const res = await call("/.well-known/jwks.json", { ca });
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body).keys[0].kty).toBe("RSA");
	});

	it("is refused by a client that does not trust the root", async () => {
		await expect(call("/.well-known/jwks.json")).rejects.toThrow(/certificate/i);
	});

	it("issues a roster token for an assertion the keyset file verifies", async () => {
		const clientAssertion = await new SignJWT({
			iss: CLIENT_ID,
			sub: CLIENT_ID,
			aud: `${base}/token`,
			jti: randomUUID(),
		})
			.setProtectedHeader({ alg: "RS256", kid: "tool-1" })
			.setExpirationTime("5m")
			.sign(toolKey);
		const res = await call("/token", {
			ca,
			form: {
				grant_type: "client_credentials",
				client_assertion_type: ASSERTION_TYPE,
				client_assertion: clientAssertion,
				scope: NRPS_SCOPE,
			},
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body).token_type).toBe("Bearer");
	});
});

describe("keysFromFile", () => {
	it("refuses a file with no keys", () => {
		const path = join(dir, "empty.json");
		writeFileSync(path, JSON.stringify({ keys: [] }));
		expect(() => keysFromFile(path)).toThrow(/no keyset/);
	});
});
