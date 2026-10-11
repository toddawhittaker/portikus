import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli.js";

describe("parseArgs", () => {
	it("defaults to loopback, port 8765, and an issuer from the first bind", () => {
		expect(parseArgs(["--", "--tool-url", "http://localhost:3000/"])).toEqual({
			port: 8765,
			binds: ["127.0.0.1"],
			toolUrl: "http://localhost:3000",
			issuer: "http://127.0.0.1:8765",
		});
	});

	it("takes repeated binds and an explicit issuer", () => {
		const opts = parseArgs([
			"--bind",
			"127.0.0.1",
			"--bind",
			"10.100.0.1",
			"--port",
			"9000",
			"--tool-url",
			"https://portikus.test",
			"--issuer",
			"http://10.100.0.1:9000",
		]);
		expect(opts.binds).toEqual(["127.0.0.1", "10.100.0.1"]);
		expect(opts.issuer).toBe("http://10.100.0.1:9000");
		expect(parseArgs(["--bind", "::1", "--tool-url", "http://x.test"]).issuer).toBe(
			"http://[::1]:8765",
		);
	});

	it("serves https with a certificate, and the default issuer says so", () => {
		const opts = parseArgs([
			"--tool-url",
			"https://portikus.test",
			"--bind",
			"10.200.0.1",
			"--tls-cert",
			"/tmp/mock.crt",
			"--tls-key",
			"/tmp/mock.key",
			"--tool-keys-file",
			"/tmp/jwks.json",
		]);
		expect(opts.tls).toEqual({ certFile: "/tmp/mock.crt", keyFile: "/tmp/mock.key" });
		expect(opts.issuer).toBe("https://10.200.0.1:8765");
		expect(opts.toolKeysFile).toBe("/tmp/jwks.json");
	});

	it.each([
		[[], /tool-url/],
		[["--tool-url"], /needs a value/],
		[["--tool-url", "ftp://x"], /http/],
		[["--tool-url", "not a url"], /URL/],
		[["--tool-url", "http://x", "--port", "0"], /port/],
		[["--tool-url", "http://x", "--color", "red"], /unknown flag/],
		[["--tool-url", "http://x", "--tls-cert", "c"], /go together/],
		[["--tool-url", "http://x", "--tls-key", "k"], /go together/],
		// Registered URLs that the mock does not serve would fail every launch.
		[
			["--tool-url", "http://x", "--issuer", "https://10.0.0.1:8765"],
			/needs --tls-cert/,
		],
		[
			[
				"--tool-url",
				"http://x",
				"--issuer",
				"http://10.0.0.1:8765",
				"--tls-cert",
				"c",
				"--tls-key",
				"k",
			],
			/must be https/,
		],
	])("refuses %j", (argv, message) => {
		expect(() => parseArgs(argv)).toThrow(message);
	});
});
