import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { afterAll, beforeAll, expect, test } from "vitest";
import { sendAlert, webhookBody } from "./alerts.js";

/**
 * One real delivery: sendAlert's webhook through the proxy-aware fetch, a
 * CONNECT tunnel, and a TLS server whose certificate is verified (ADR 0052).
 */

const HOST = "hooks.example.test";
const dir = mkdtempSync(join(tmpdir(), "alerts-delivery-"));
const defaultCas = getCACertificates("default");
const tunnels: string[] = [];
const received: Array<{ path: string; body: string }> = [];
let hooks: Server;
let proxy: Server;
let proxyUrl = "";

beforeAll(async () => {
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"ec",
			"-pkeyopt",
			"ec_paramgen_curve:prime256v1",
			"-nodes",
			"-days",
			"1",
			"-subj",
			`/CN=${HOST}`,
			"-addext",
			`subjectAltName=DNS:${HOST}`,
			"-keyout",
			"key.pem",
			"-out",
			"cert.pem",
		],
		{ cwd: dir, stdio: "ignore" },
	);
	const cert = readFileSync(join(dir, "cert.pem"), "utf8");
	// The test certificate is trusted the way a public one would be: as a default CA.
	setDefaultCACertificates([...defaultCas, cert]);
	hooks = createHttpsServer(
		{ key: readFileSync(join(dir, "key.pem")), cert },
		(req, res) => {
			let body = "";
			req.on("data", (c) => {
				body += c;
			});
			req.on("end", () => {
				received.push({ path: req.url ?? "", body });
				res.end("{}");
			});
		},
	);
	await new Promise<void>((r) => hooks.listen(0, "127.0.0.1", r));
	const hooksPort = (hooks.address() as AddressInfo).port;
	// A CONNECT proxy stub, as Squid is: every tunnel leads to the local TLS server.
	proxy = createHttpServer((_req, res) => {
		res.statusCode = 405;
		res.end();
	});
	proxy.on("connect", (req, socket, head) => {
		tunnels.push(req.url ?? "");
		const upstream = connect(hooksPort, "127.0.0.1", () => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			upstream.write(head);
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
	});
	await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
	proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

afterAll(async () => {
	setDefaultCACertificates(defaultCas);
	proxy.closeAllConnections();
	hooks.closeAllConnections();
	await new Promise((r) => proxy.close(r));
	await new Promise((r) => hooks.close(r));
	rmSync(dir, { recursive: true, force: true });
});

const alert = {
	title: "A backup failed",
	text: "The Backups tab shows why.",
	tone: "danger" as const,
	at: new Date("2026-10-04T12:00:00Z"),
};

test("a webhook alert reaches a TLS server through the egress proxy's tunnel", async () => {
	const results = await sendAlert(
		{
			pushoverUserKey: "",
			pushoverAppToken: "",
			webhookUrl: `https://${HOST}/services/T0`,
			email: null,
			ntfy: null,
			teamsUrl: "",
			proxyUrl,
		},
		alert,
		"site-a",
	);
	expect(results).toEqual([{ channel: "webhook", ok: true }]);
	expect(tunnels).toEqual([`${HOST}:443`]);
	expect(received).toEqual([
		{ path: "/services/T0", body: JSON.stringify(webhookBody(alert, "site-a")) },
	]);
});

test("a certificate the site does not trust is refused, and nothing is delivered", async () => {
	setDefaultCACertificates(defaultCas);
	try {
		const results = await sendAlert(
			{
				pushoverUserKey: "",
				pushoverAppToken: "",
				webhookUrl: `https://${HOST}/services/T1`,
				email: null,
				ntfy: null,
				teamsUrl: "",
				proxyUrl,
			},
			alert,
			"site-a",
		);
		expect(results[0]).toMatchObject({ channel: "webhook", ok: false });
		expect(received.map((r) => r.path)).not.toContain("/services/T1");
	} finally {
		setDefaultCACertificates([
			...defaultCas,
			readFileSync(join(dir, "cert.pem"), "utf8"),
		]);
	}
});
