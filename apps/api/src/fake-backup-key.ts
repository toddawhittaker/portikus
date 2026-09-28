import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";

/**
 * A stand-in for the root backup key helper (packaging/backup/backup-key,
 * ADR 0044) for the API tests and the browser tests: the same verbs and
 * answers over a Unix socket, with made-up keys in place of age's.
 */

export interface FakeKeyState {
	/** The installed identity line, or null for no key. */
	identity: string | null;
	handedOut: { recipient: string; at: number } | null;
}

export interface FakeBackupKey {
	socketPath: string;
	/** Every verb asked, in order. */
	verbs: string[];
	state(): FakeKeyState;
	setState(state: FakeKeyState): void;
	close(): Promise<void>;
}

const IDENTITY = /^AGE-SECRET-KEY-1[0-9A-Z]{58}$/;

/** A key shaped like age's, and its public half. Built here, so no key literal sits in the tree. */
export function fakeKey(seed: string): {
	identity: string;
	recipient: string;
	file: string;
} {
	const hex = createHash("sha256").update(seed).digest("hex");
	const identity = `AGE-SECRET-KEY-1${(hex + hex).slice(0, 58).toUpperCase()}`;
	const recipient = recipientOf(identity);
	return { identity, recipient, file: `# public key: ${recipient}\n${identity}\n` };
}

function recipientOf(identity: string): string {
	const hex = createHash("sha256").update(identity).digest("hex");
	return `age1${(hex + hex).slice(0, 58)}`;
}

function answer(
	state: FakeKeyState,
	verb: string,
	body: string,
): [string, FakeKeyState] {
	const recipient = state.identity ? recipientOf(state.identity) : null;
	if (verb === "status") {
		const handed = state.handedOut;
		const doc = {
			installed: state.identity !== null,
			recipient,
			handedOutRecipient: handed?.recipient ?? null,
			handedOutAt: handed?.at ?? null,
		};
		return [`ok\n${JSON.stringify(doc)}\n`, state];
	}
	if (verb === "export") {
		if (!state.identity || !recipient) return ["error no-key\n", state];
		const now = Math.floor(Date.now() / 1000);
		return [
			`ok ${recipient}\n# public key: ${recipient}\n${state.identity}\n`,
			{ ...state, handedOut: { recipient, at: now } },
		];
	}
	if (verb === "import" || verb === "import-replace") {
		if (Buffer.byteLength(body) > 4096) return ["error too-large\n", state];
		const lines = body
			.replaceAll("\r", "")
			.split("\n")
			.filter((line) => line !== "" && !line.startsWith("#"));
		const identity = lines[0];
		if (lines.length !== 1 || !identity || !IDENTITY.test(identity)) {
			return ["error invalid\n", state];
		}
		const uploaded = recipientOf(identity);
		const now = Math.floor(Date.now() / 1000);
		const handedOut = { recipient: uploaded, at: now };
		if (uploaded === recipient)
			return [`ok unchanged ${uploaded}\n`, { identity, handedOut }];
		if (recipient && verb !== "import-replace") return ["error exists\n", state];
		return [`ok installed ${uploaded} ${recipient ?? "-"}\n`, { identity, handedOut }];
	}
	return ["error unknown-verb\n", state];
}

/**
 * Listen on `socketPath`. With `stateFile`, the state lives in that JSON
 * file, so another process (a browser test) can read and reset it.
 */
export function startFakeBackupKey(
	socketPath: string,
	initial: FakeKeyState,
	stateFile?: string,
): Promise<FakeBackupKey> {
	let memory = initial;
	const read = (): FakeKeyState =>
		stateFile && existsSync(stateFile)
			? (JSON.parse(readFileSync(stateFile, "utf8")) as FakeKeyState)
			: memory;
	const write = (state: FakeKeyState) => {
		memory = state;
		if (stateFile) writeFileSync(stateFile, JSON.stringify(state));
	};
	// A file left by an earlier run on the same port starts over.
	write(initial);
	const verbs: string[] = [];
	rmSync(socketPath, { force: true });
	const server: Server = createServer((socket) => {
		const chunks: Buffer[] = [];
		socket.on("data", (chunk: Buffer) => chunks.push(chunk));
		socket.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			const newline = text.indexOf("\n");
			const verb = newline === -1 ? text : text.slice(0, newline);
			verbs.push(verb);
			const [reply, next] = answer(
				read(),
				verb,
				newline === -1 ? "" : text.slice(newline + 1),
			);
			write(next);
			socket.end(reply);
		});
		socket.on("error", () => socket.destroy());
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			resolve({
				socketPath,
				verbs,
				state: read,
				setState: write,
				close: () =>
					new Promise<void>((done) => {
						server.close(() => done());
					}),
			});
		});
	});
}
