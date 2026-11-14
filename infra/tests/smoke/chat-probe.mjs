// The browser end of the chat socket, run on the VM by smoke/chat.sh.
// Claude (the default): it reads frames, reports whether the first is a
// snapshot, sends set {mode: "plan"}, and waits for a settings event carrying
// that mode. The attach also sends a settings event, with the default mode, so
// only the plan one counts.
// Codex (a fourth argument, "codex"): it sends nothing and waits for the frames
// a Codex host sends on attach with no sign-in: the snapshot first, then the
// models, the five modes, and settings naming the agent codex (SPEC.md 10.8).
// It prints one word per fact and never sends a prompt.
import fs from "node:fs";

// url, origin, timeout in milliseconds, then the agent ("claude" if absent);
// the session cookie arrives on stdin.
const [url, origin, timeoutMs, agent = "claude"] = process.argv.slice(2);
const codex = agent === "codex";
const CODEX_MODES = 5;
const cookie = fs.readFileSync(0, "utf8").trim();
const ws = new WebSocket(url, { headers: { origin, cookie } });
let first = true;
let sent = false;
const seen = new Set();
const done = (code) => {
	clearTimeout(timer);
	ws.close();
	process.exit(code);
};
const timer = setTimeout(() => {
	console.log("timeout");
	done(1);
}, Number(timeoutMs));
// Print a fact once; a Codex probe is done when the models, modes and
// settings are in (it has already failed unless the snapshot came first).
const fact = (word) => {
	if (seen.has(word)) return;
	seen.add(word);
	console.log(word);
	if (codex && ["models", "modes-5", "settings-codex"].every((w) => seen.has(w))) {
		done(0);
	}
};
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
		if (codex && frame.type !== "snapshot") done(1);
	}
	if (codex) {
		if (frame.type === "models") fact("models");
		if (frame.type === "modes" && Array.isArray(frame.modes)) {
			if (frame.modes.length === CODEX_MODES) fact("modes-5");
			else console.log(`modes-${frame.modes.length}`);
		}
		if (frame.type === "settings") {
			if (frame.agent === "codex") fact("settings-codex");
			else console.log(`settings-agent-${frame.agent}`);
		}
		return;
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
