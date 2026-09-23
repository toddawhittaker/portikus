// A terminal input the prompter can switch into raw mode, so typed passwords are never echoed.
export type TtyInput = NodeJS.ReadableStream & {
	isTTY?: boolean;
	setRawMode?: (mode: boolean) => unknown;
};

export class PromptAborted extends Error {
	constructor() {
		super("cancelled");
	}
}

// Reads lines from a raw-mode terminal. Echo is done here, character by character,
// so a hidden prompt simply writes nothing back.
export class Prompter {
	private buffer = "";
	private waiting: (() => void) | undefined;
	private ended = false;
	private readonly onData = (chunk: Buffer | string) => {
		this.buffer += chunk.toString();
		this.waiting?.();
	};
	private readonly onEnd = () => {
		this.ended = true;
		this.waiting?.();
	};

	constructor(
		private readonly input: TtyInput,
		private readonly output: NodeJS.WritableStream,
	) {
		input.setRawMode?.(true);
		input.on("data", this.onData);
		input.on("end", this.onEnd);
		input.resume();
	}

	close(): void {
		this.input.off("data", this.onData);
		this.input.off("end", this.onEnd);
		this.input.setRawMode?.(false);
		this.input.pause();
	}

	private async nextChar(): Promise<string> {
		while (this.buffer.length === 0) {
			if (this.ended) throw new PromptAborted();
			await new Promise<void>((resolve) => {
				this.waiting = resolve;
			});
			this.waiting = undefined;
		}
		const char = this.buffer[0] as string;
		this.buffer = this.buffer.slice(1);
		return char;
	}

	async ask(question: string, options: { echo: boolean }): Promise<string> {
		this.output.write(question);
		let line = "";
		for (;;) {
			const char = await this.nextChar();
			if (char === "\r" || char === "\n") {
				this.output.write("\r\n");
				return line;
			}
			if (char === "\u0003" || (char === "\u0004" && line === "")) {
				this.output.write("\r\n");
				throw new PromptAborted();
			}
			if (char === "\u007f" || char === "\b") {
				if (line.length > 0) {
					line = line.slice(0, -1);
					if (options.echo) this.output.write("\b \b");
				}
				continue;
			}
			// Ignore other control characters, such as the start of an arrow key.
			if (char < " ") continue;
			line += char;
			if (options.echo) this.output.write(char);
		}
	}
}

// For --password-stdin: the first line of a non-terminal stdin.
export async function readFirstLine(input: NodeJS.ReadableStream): Promise<string> {
	let text = "";
	for await (const chunk of input) {
		text += chunk.toString();
		if (text.includes("\n")) break;
	}
	const line = text.split("\n")[0] ?? "";
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}
