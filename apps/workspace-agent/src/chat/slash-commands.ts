import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { ChatCommand } from "@portikus/contracts";
import { chatCommands } from "./claude-adapter.js";

/** The slash commands a chat tab offers, told to the host only when they change. */
export class SlashCommandList {
	/** The commands last reported; null until Claude has reported any. */
	current: ChatCommand[] | null = null;
	/** The commands the SDK's init message named, for when their descriptions cannot be read. */
	private init: { names: string[]; terminalOnly: Set<string> } | null = null;

	constructor(private readonly onChange: (commands: ChatCommand[]) => void) {}

	initKnown(names: string[] | undefined, terminal: string[] | undefined): void {
		this.init = { names: names ?? [], terminalOnly: new Set(terminal ?? []) };
	}

	changed(commands: SlashCommand[]): void {
		this.set(chatCommands(commands, this.init?.terminalOnly));
	}

	/** Read the command descriptions, falling back to the names init gave. */
	async refresh(
		read: () => Promise<SlashCommand[]>,
		stillCurrent: () => boolean,
	): Promise<void> {
		try {
			const commands = chatCommands(await read(), this.init?.terminalOnly);
			if (stillCurrent()) this.set(commands);
		} catch {
			const init = this.init;
			if (!init || this.current !== null || !stillCurrent()) return;
			const named = init.names.map((name) => ({
				name,
				description: "",
				argumentHint: "",
			}));
			this.set(chatCommands(named, init.terminalOnly));
		}
	}

	private set(commands: ChatCommand[]): void {
		if (commands.length === 0 && this.current === null) return;
		if (JSON.stringify(commands) === JSON.stringify(this.current)) return;
		this.current = commands;
		this.onChange(commands);
	}
}
