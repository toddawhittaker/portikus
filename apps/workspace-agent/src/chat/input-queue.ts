import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** Streaming input for the SDK: messages are pushed as the student sends them. */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
	private readonly items: SDKUserMessage[] = [];
	private wake: (() => void) | null = null;

	push(message: SDKUserMessage): void {
		this.items.push(message);
		this.wake?.();
		this.wake = null;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		for (;;) {
			const next = this.items.shift();
			if (next) {
				yield next;
				continue;
			}
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		}
	}
}
