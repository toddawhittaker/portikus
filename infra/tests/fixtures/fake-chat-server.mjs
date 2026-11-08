// A stand-in for the chat socket, built on Node's own modules only, for
// chat-probe-test.sh. Usage: node fake-chat-server.mjs <scenario>
// It prints the port it listens on, then serves one scenario:
//   good        snapshot, settings (default), then plan settings after a set
//   no-snapshot settings first, so the probe sees a wrong first frame
//   ignores-set snapshot and default settings, but never answers a set
//   refuses     accepts the handshake, then closes with 4404
import { createHash } from "node:crypto";
import http from "node:http";

const scenario = process.argv[2];
const text = (payload) => {
	const body = Buffer.from(JSON.stringify(payload));
	return Buffer.concat([Buffer.from([0x81, body.length]), body]);
};
const close = (code) => Buffer.from([0x88, 2, code >> 8, code & 0xff]);
const snapshot = {
	type: "snapshot",
	seq: 0,
	messages: [],
	cards: [],
	turnRunning: false,
	truncated: false,
};
const settings = (mode) => ({
	type: "settings",
	seq: 1,
	agent: "claude",
	model: "default",
	effort: "medium",
	mode,
});

const server = http.createServer();
server.on("upgrade", (request, socket) => {
	const accept = createHash("sha1")
		.update(
			`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
		)
		.digest("base64");
	socket.write(
		`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
	);
	if (scenario === "refuses") {
		setTimeout(() => socket.end(close(4404)), 100);
		return;
	}
	if (scenario === "no-snapshot") socket.write(text(settings("default")));
	else {
		socket.write(text(snapshot));
		socket.write(text(settings("default")));
	}
	socket.on("data", (frame) => {
		if ((frame[0] & 0x0f) !== 1) return;
		// Client frames are masked and short here; the payload follows the 4-byte mask.
		const length = frame[1] & 0x7f;
		const mask = frame.subarray(2, 6);
		const payload = Buffer.from(
			frame.subarray(6, 6 + length).map((byte, i) => byte ^ mask[i % 4]),
		);
		const message = JSON.parse(payload.toString("utf8"));
		if (scenario === "good" && message.type === "set")
			socket.write(text(settings(message.mode)));
	});
	socket.on("error", () => {});
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
