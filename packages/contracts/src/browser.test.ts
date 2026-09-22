import { expect, test } from "vitest";
import {
	BrokerOpenReply,
	BrokerOpenRequest,
	BrowserOpenRequest,
	classifyBrokerUrl,
	MAX_BROKER_URL_LENGTH,
	REDACTED_URL,
	redactUrl,
} from "./index.js";

const requestId = "550e8400-e29b-41d4-a716-446655440000";
const workspaceId = "550e8400-e29b-41d4-a716-446655440111";

test("the unix-socket request and reply stay strict", () => {
	const body = { requestId, url: "https://example.com/login" };
	expect(BrokerOpenRequest.parse(body)).toEqual(body);
	expect(
		BrokerOpenRequest.parse({
			...body,
			executable: "codex",
			pid: 42,
			cwd: "/home/student",
		}),
	).toEqual({ ...body, executable: "codex", pid: 42, cwd: "/home/student" });
	expect(BrokerOpenRequest.safeParse({ ...body, command: "open" }).success).toBe(false);
	expect(BrokerOpenReply.parse({ ok: true })).toEqual({ ok: true });
	expect(BrokerOpenReply.parse({ ok: false, reason: "rejected" })).toEqual({
		ok: false,
		reason: "rejected",
	});
	expect(BrokerOpenReply.safeParse({ ok: false }).success).toBe(false);
	expect(BrokerOpenReply.safeParse({ ok: true, reason: "no" }).success).toBe(false);
});

test("the events frame names brokerClass and carries an optional source", () => {
	const frame = {
		type: "browser.open.request" as const,
		requestId,
		workspaceId,
		url: "http://127.0.0.1:5173/",
		brokerClass: "loopback-preview" as const,
		requestedAt: "2026-01-01T00:00:00.000Z",
	};
	expect(BrowserOpenRequest.parse(frame)).toEqual(frame);
	expect(
		BrowserOpenRequest.parse({
			...frame,
			terminalId: requestId,
			brokerClass: "loopback-login",
			source: { executable: "claude", pid: 7, cwd: "/work" },
		}).brokerClass,
	).toBe("loopback-login");
	expect(
		BrowserOpenRequest.safeParse({ ...frame, brokerClass: "device" }).success,
	).toBe(false);
	expect(BrowserOpenRequest.safeParse({ ...frame, class: "external" }).success).toBe(
		false,
	);
});

test("classifyBrokerUrl rejects schemes, userinfo, garbage, controls, and overlong input", () => {
	expect(classifyBrokerUrl("javascript:alert(1)")).toEqual({
		outcome: "reject",
		reason: "scheme",
	});
	expect(classifyBrokerUrl("data:text/html,hi")).toEqual({
		outcome: "reject",
		reason: "scheme",
	});
	expect(classifyBrokerUrl("file:///etc/passwd")).toEqual({
		outcome: "reject",
		reason: "scheme",
	});
	expect(classifyBrokerUrl("ftp://example.com/file")).toEqual({
		outcome: "reject",
		reason: "scheme",
	});
	expect(classifyBrokerUrl("https://user:secret@example.com/a")).toEqual({
		outcome: "reject",
		reason: "userinfo",
	});
	expect(classifyBrokerUrl("https://user@example.com/")).toEqual({
		outcome: "reject",
		reason: "userinfo",
	});
	expect(classifyBrokerUrl("not a url")).toEqual({
		outcome: "reject",
		reason: "malformed",
	});
	expect(classifyBrokerUrl("http://")).toEqual({
		outcome: "reject",
		reason: "malformed",
	});
	expect(classifyBrokerUrl("https://example.com/\nsecret")).toEqual({
		outcome: "reject",
		reason: "control-character",
	});
	expect(
		classifyBrokerUrl(`https://example.com/${"a".repeat(MAX_BROKER_URL_LENGTH)}`),
	).toEqual({
		outcome: "reject",
		reason: "too-long",
	});
});

test("classifyBrokerUrl keeps loopback hosts, with the port only when it was written", () => {
	expect(classifyBrokerUrl("http://127.0.0.1/app")).toEqual({ outcome: "loopback" });
	expect(classifyBrokerUrl("http://localhost/")).toEqual({ outcome: "loopback" });
	expect(classifyBrokerUrl("http://[::1]/")).toEqual({ outcome: "loopback" });
	expect(classifyBrokerUrl("http://127.0.0.1:5173/")).toEqual({
		outcome: "loopback",
		port: 5173,
	});
	expect(classifyBrokerUrl("http://localhost:43127/callback")).toEqual({
		outcome: "loopback",
		port: 43127,
	});
	expect(classifyBrokerUrl("https://[::1]:8443/login")).toEqual({
		outcome: "loopback",
		port: 8443,
	});
	// Absolute DNS form of the loopback name. This function does not decide
	// preview versus login.
	expect(classifyBrokerUrl("http://localhost.:3000/")).toEqual({
		outcome: "loopback",
		port: 3000,
	});
	expect(classifyBrokerUrl("http://127.0.0.2/")).toEqual({ outcome: "loopback" });
	expect(classifyBrokerUrl("http://0.0.0.0/")).toEqual({ outcome: "loopback" });
	expect(classifyBrokerUrl("http://[::]/")).toEqual({ outcome: "loopback" });
	expect(classifyBrokerUrl("http://[::ffff:127.0.0.1]/")).toEqual({
		outcome: "loopback",
	});
	expect(classifyBrokerUrl("http://2130706433/")).toEqual({ outcome: "loopback" });
	expect(classifyBrokerUrl("http://127.1/")).toEqual({ outcome: "loopback" });
	expect(classifyBrokerUrl("http://app.localhost/")).toEqual({ outcome: "loopback" });
	expect(classifyBrokerUrl("http://app.localhost./")).toEqual({ outcome: "loopback" });
	expect(classifyBrokerUrl("http://10.1.2.3/")).toEqual({ outcome: "loopback" });
	expect(classifyBrokerUrl("http://172.16.0.1/")).toEqual({ outcome: "loopback" });
	expect(classifyBrokerUrl("http://192.168.0.1/")).toEqual({ outcome: "loopback" });
	expect(classifyBrokerUrl("http://169.254.1.1/")).toEqual({ outcome: "loopback" });
	expect(classifyBrokerUrl("http://[fd00::1]/")).toEqual({ outcome: "loopback" });
	expect(classifyBrokerUrl("http://[fe80::1]/")).toEqual({ outcome: "loopback" });
	expect(classifyBrokerUrl("http://[::ffff:10.0.0.1]/")).toEqual({
		outcome: "loopback",
	});
});

test("classifyBrokerUrl returns the normalized origin of any other http(s) URL", () => {
	expect(classifyBrokerUrl("HTTPS://Example.COM/path?code=abc#frag")).toEqual({
		outcome: "external",
		origin: "https://example.com",
	});
	expect(classifyBrokerUrl("http://example.com:8443/x")).toEqual({
		outcome: "external",
		origin: "http://example.com:8443",
	});
	expect(classifyBrokerUrl("http://172.32.0.1/")).toEqual({
		outcome: "external",
		origin: "http://172.32.0.1",
	});
	expect(classifyBrokerUrl("http://[2001:db8::1]/")).toEqual({
		outcome: "external",
		origin: "http://[2001:db8::1]",
	});
	expect(classifyBrokerUrl("http://localhost.evil.example/")).toEqual({
		outcome: "external",
		origin: "http://localhost.evil.example",
	});
});

test("redactUrl keeps only the origin", () => {
	expect(redactUrl("https://user:secret@example.com/path?token=abc#frag")).toBe(
		"https://example.com",
	);
	expect(redactUrl("http://127.0.0.1:5173/callback?code=1")).toBe(
		"http://127.0.0.1:5173",
	);
	const junk = "zzzz-not-a-url-secret";
	expect(redactUrl(junk)).toBe(REDACTED_URL);
	expect(REDACTED_URL).not.toContain("zzzz");
	expect(redactUrl("javascript:alert(1)")).toBe(REDACTED_URL);
	expect(redactUrl(`https://example.com/${"q".repeat(MAX_BROKER_URL_LENGTH)}`)).toBe(
		REDACTED_URL,
	);
});
