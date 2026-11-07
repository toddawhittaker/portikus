// The browser end of the chat socket, run on the VM by smoke/chat.sh.
// It reads frames, reports whether the first is a snapshot, sends
// set {mode: "plan"}, and waits for a settings event carrying that mode.
// The attach also sends a settings event, with the default mode, so only the
// plan one counts. It prints one word per fact and never sends a prompt.
import fs from "node:fs";

// url, origin, timeout in milliseconds; the session cookie arrives on stdin.
const [url, origin, timeoutMs] = process.argv.slice(2);
const cookie = fs.readFileSync(0, "utf8").trim();
const ws = new WebSocket(url, { headers: { origin, cookie } });
let first = true;
let sent = false;
const done = (code) => {
	clearTimeout(timer);
	ws.close();
	process.exit(code);
};
const timer = setTimeout(() => {
	console.log("timeout");
	done(1);
}, Number(timeoutMs));
ws.addEventListener("message", (event) => {
	if (typeof event.data !== "string") return;
	let frame;
	try {
		frame = JSON.parse(event.data);
	} catch {
		return;
	}
	if (first) {
		first = false;
		console.log(frame.type === "snapshot" ? "snapshot" : `first-frame-${frame.type}`);
	}
	if (frame.type === "snapshot" && !sent) {
		sent = true;
		ws.send(JSON.stringify({ type: "set", mode: "plan" }));
	}
	if (frame.type === "settings" && frame.mode === "plan") {
		console.log("settings-plan");
		done(0);
	}
});
ws.addEventListener("error", (event) => {
	console.error("socket error", event.message ?? "");
	process.exit(1);
});
ws.addEventListener("close", (event) => {
	console.log(`closed-${event.code}`);
	process.exit(1);
});
