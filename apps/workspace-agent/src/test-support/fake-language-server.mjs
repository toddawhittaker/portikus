// A scripted language server for the agent's lifecycle tests. It answers
// `initialize` with the params it received, and a few test methods make it
// misbehave on demand.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

let pending = Buffer.alloc(0);

function send(message) {
	const body = Buffer.from(JSON.stringify(message));
	process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
	process.stdout.write(body);
}

if (process.env.FAKE_PID_FILE)
	writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
// A child of its own, so a test can see the whole tree die.
if (process.env.FAKE_CHILD_PID_FILE) {
	const sleeper = spawn("sleep", ["600"], { stdio: "ignore" });
	writeFileSync(process.env.FAKE_CHILD_PID_FILE, String(sleeper.pid));
}
process.stderr.write("fake server noise on stderr\n");

function handle(message) {
	switch (message.method) {
		case "initialize":
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: { capabilities: {}, received: message.params },
			});
			return;
		case "test/echo":
			send({ jsonrpc: "2.0", id: message.id, result: message.params });
			return;
		case "test/big":
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: "x".repeat(message.params.bytes),
			});
			return;
		case "test/bigNotification":
			send({
				jsonrpc: "2.0",
				method: "test/note",
				params: "x".repeat(message.params.bytes),
			});
			send({ jsonrpc: "2.0", id: message.id, result: "sent" });
			return;
		case "test/env":
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: { path: process.env.PATH, cwd: process.cwd() },
			});
			return;
		case "test/crash":
			process.exit(3);
			return;
		case "test/selfKill":
			process.kill(process.pid, "SIGKILL");
			return;
		case "shutdown":
			if (process.env.FAKE_IGNORE_EXIT) return;
			send({ jsonrpc: "2.0", id: message.id, result: null });
			return;
		case "exit":
			if (process.env.FAKE_IGNORE_EXIT) return;
			process.exit(0);
			return;
		default:
			if (message.id !== undefined)
				send({ jsonrpc: "2.0", id: message.id, result: null });
	}
}

process.stdin.on("data", (chunk) => {
	pending = Buffer.concat([pending, chunk]);
	for (;;) {
		const end = pending.indexOf("\r\n\r\n");
		if (end === -1) return;
		const length = Number(
			/Content-Length: (\d+)/i.exec(pending.subarray(0, end).toString())[1],
		);
		if (pending.length < end + 4 + length) return;
		const body = pending.subarray(end + 4, end + 4 + length).toString();
		pending = pending.subarray(end + 4 + length);
		handle(JSON.parse(body));
	}
});
// With FAKE_IGNORE_EXIT it must outlive a closed stdin, so the agent has to kill it.
process.stdin.on("end", () => {
	if (!process.env.FAKE_IGNORE_EXIT) process.exit(0);
});
if (process.env.FAKE_IGNORE_EXIT) setInterval(() => {}, 1000);
