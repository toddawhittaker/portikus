import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { ChatModel, type ChatModelInfo, MAX_CHAT_MODELS } from "@portikus/contracts";

/**
 * The rows of `supportedModels()` as the chat sends them: a row whose value
 * the contract would refuse is left out, and long text is cut to fit.
 */
export function chatModels(rows: readonly ModelInfo[]): ChatModelInfo[] {
	const models: ChatModelInfo[] = [];
	for (const row of rows) {
		if (!ChatModel.safeParse(row.value).success) continue;
		models.push({
			value: row.value,
			...(row.resolvedModel && row.resolvedModel.length <= 100
				? { resolvedModel: row.resolvedModel }
				: {}),
			displayName: row.displayName.slice(0, 100),
			description: row.description.slice(0, 300),
			supportsAutoMode: row.supportsAutoMode === true,
		});
	}
	return models.slice(0, MAX_CHAT_MODELS);
}

/** The models Claude Code offers this account, told to the host only when they change. */
export class ModelList {
	/** The models last read; null until a read has worked. */
	current: ChatModelInfo[] | null = null;
	/** The read begun last, which a first attach waits for. */
	private reading: Promise<unknown> = Promise.resolve();

	constructor(private readonly onChange: (models: ChatModelInfo[]) => void) {}

	/**
	 * Read the list. A failed read keeps what is held, so the picker keeps
	 * its last list. Returns the list read, or null when the read failed.
	 */
	refresh(
		read: () => Promise<ModelInfo[]>,
		stillCurrent: () => boolean,
	): Promise<ChatModelInfo[] | null> {
		const reading = this.read(read, stillCurrent);
		this.reading = reading;
		return reading;
	}

	/** Wait for the read begun last, but no longer than `ms`. */
	async settled(ms: number): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		const late = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, ms);
		});
		try {
			await Promise.race([this.reading, late]);
		} finally {
			clearTimeout(timer);
		}
	}

	private async read(
		read: () => Promise<ModelInfo[]>,
		stillCurrent: () => boolean,
	): Promise<ChatModelInfo[] | null> {
		try {
			const models = chatModels(await read());
			if (!stillCurrent()) return null;
			if (JSON.stringify(models) !== JSON.stringify(this.current)) {
				this.current = models;
				this.onChange(models);
			}
			return models;
		} catch {
			return null;
		}
	}
}
