import http from "node:http";
import type { AddressInfo } from "node:net";
import { silentLogger } from "@portikus/observability";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { IncusClient } from "./incus.js";
import { IncusError } from "./incus.js";
import { IncusWorkspaceProvider } from "./provider.js";
import {
	AGENT_TOKEN_PATH,
	PROFILE_PATH,
	setHostname,
	setTimezone,
} from "./start-setup.js";

/**
 * An in-memory Incus that records each file write with the container's
 * state at that moment, and fails the test outright on a write while it
 * runs: a student's named pipe could race the delete-then-push then.
 */
function fakeClient(opts: { hostnameStatus?: number; lnStatus?: number } = {}) {
	const state = { status: "Stopped" };
	const writes: Array<{ path: string; status: string }> = [];
	const client = {
		project: "portikus",
		async request(method: string, path: string, body?: unknown): Promise<unknown> {
			if (method === "GET" && path.endsWith("/state")) {
				return {
					status: state.status,
					network: {
						eth0: {
							addresses: [{ family: "inet", scope: "global", address: "127.0.0.1" }],
						},
					},
				};
			}
			if (method === "PUT" && path.endsWith("/state")) {
				state.status =
					(body as { action: string }).action === "start" ? "Running" : "Stopped";
				return {};
			}
			return { devices: {}, config: {} };
		},
		async getWithEtag(): Promise<{ metadata: unknown; etag: string }> {
			return { metadata: { status: state.status, config: {} }, etag: "e1" };
		},
		async putIfMatch(): Promise<void> {},
		async replaceFile(_name: string, path: string): Promise<void> {
			writes.push({ path, status: state.status });
		},
		async pushFile(_name: string, path: string): Promise<void> {
			writes.push({ path, status: state.status });
		},
		async exec(_name: string, command: string[]) {
			let status = 0;
			if (command[0] === "hostname") status = opts.hostnameStatus ?? 0;
			if (command[0] === "ln") status = opts.lnStatus ?? 0;
			return { status, stdout: Buffer.alloc(0), tooLarge: false };
		},
	};
	return { client, state, writes };
}

let agent: http.Server;
let agentPort: number;

beforeEach(async () => {
	agent = http.createServer((_req, res) => res.end("ok"));
	await new Promise<void>((r) => agent.listen(0, "127.0.0.1", r));
	agentPort = (agent.address() as AddressInfo).port;
});

afterEach(async () => {
	await new Promise((r) => agent.close(r));
});

function provider(client: unknown, logger = silentLogger()): IncusWorkspaceProvider {
	return new IncusWorkspaceProvider({
		client: client as IncusClient,
		pool: "mypool",
		profile: "workspace",
		imageAlias: "portikus",
		agentPort,
		logger,
		agentInstructionsPath: "/nonexistent/instructions.md",
	});
}

const START = {
	timeoutSeconds: 10,
	agentToken: "secret-token",
	hostname: "my-label",
	previewHostSuffix: "preview.example.org",
	timezone: "Europe/London",
};

describe("workspace start", () => {
	test("writes every file while the container is stopped (SPEC.md section 24)", async () => {
		const fake = fakeClient();
		fake.state.status = "Running";
		await provider(fake.client).start("ws-test", START);

		const paths = fake.writes.map((w) => w.path);
		expect(paths).toEqual(
			expect.arrayContaining([
				"/etc/hostname",
				"/etc/timezone",
				PROFILE_PATH,
				AGENT_TOKEN_PATH,
			]),
		);
		expect(fake.writes.every((w) => w.status === "Stopped")).toBe(true);
		expect(fake.state.status).toBe("Running");
	});

	test("a failed hostname command warns and the start succeeds", async () => {
		const fake = fakeClient({ hostnameStatus: 1 });
		const logger = silentLogger();
		const warn = vi.spyOn(logger, "warn");

		const result = await provider(fake.client, logger).start("ws-test", START);

		expect(result).toEqual({ ipv4: "127.0.0.1" });
		expect(warn).toHaveBeenCalledWith(
			{ instance: "ws-test", status: 1 },
			expect.stringContaining("hostname"),
		);
		// ADR 0012: the agent token never reaches a log line.
		expect(JSON.stringify(warn.mock.calls)).not.toContain(START.agentToken);
	});

	test("a missing timezone file fails the start", async () => {
		const fake = fakeClient({ lnStatus: 1 });
		await expect(provider(fake.client).start("ws-test", START)).rejects.toMatchObject({
			code: "OPERATION_FAILED",
		});
	});
});

describe("setHostname and setTimezone", () => {
	test("setHostname runs hostname with the label and stays quiet on success", async () => {
		const fake = fakeClient();
		const exec = vi.spyOn(fake.client, "exec");
		const logger = silentLogger();
		const warn = vi.spyOn(logger, "warn");

		await setHostname(fake.client, logger, "ws-test", "my-label", 10);

		expect(exec).toHaveBeenCalledWith(
			"ws-test",
			["hostname", "my-label"],
			{ timeoutSeconds: 10 },
			undefined,
		);
		expect(warn).not.toHaveBeenCalled();
	});

	test("setTimezone throws an IncusError naming the missing zone file", async () => {
		const fake = fakeClient({ lnStatus: 1 });
		const err = await setTimezone(fake.client, "ws-test", "Europe/London", 10).catch(
			(e) => e,
		);
		expect(err).toBeInstanceOf(IncusError);
		expect((err as Error).message).toContain("/usr/share/zoneinfo/Europe/London");
	});
});
