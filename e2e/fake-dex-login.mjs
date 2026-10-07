/**
 * Stands in for Dex's password form post, which the API relays here
 * (SPEC.md section 24.13): a redirect when the password is right, the form
 * again with Dex's error when it is wrong. The real Dex is checked on the VM.
 */
import { createServer } from "node:http";

const rightPassword = process.env.FAKE_DEX_RIGHT_PASSWORD;
if (!rightPassword) throw new Error("FAKE_DEX_RIGHT_PASSWORD is required");

const port = Number(process.env.FAKE_DEX_HTTP_PORT ?? "5556");

createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => {
		body += chunk;
	});
	req.on("end", () => {
		if (req.method === "GET") {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("fake dex");
			return;
		}
		if (new URLSearchParams(body).get("password") === rightPassword) {
			res.writeHead(303, { location: "/" });
			res.end();
			return;
		}
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		// Like Dex's own page: a theme stylesheet, a logo and an inline script.
		res.end(
			'<!doctype html><html lang="en"><title>Sign in</title>' +
				'<link rel="stylesheet" href="/dex/theme/styles.css">' +
				'<main><img src="/dex/theme/logo.svg" alt="Portikus">' +
				'<p role="alert">Invalid Email Address and password.</p></main>' +
				"<script>document.documentElement.dataset.scripted = 'yes';</script></html>",
		);
	});
}).listen(port, "127.0.0.1");
