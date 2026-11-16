import {
	type ModelClient,
	type ModelError,
	type StepRequest,
	toModelError,
} from "./model.js";
import type { StepUsage } from "./usage.js";

export type CollectedStep = {
	text: string;
	calls: { id: string; name: string; input: unknown }[];
	usage: StepUsage | null;
	/** Whether the server sent anything at all. */
	started: boolean;
	error: ModelError | null;
};

/** One whole model step, for callers that do not stream it to anyone. */
export async function collectStep(
	client: ModelClient,
	req: StepRequest,
): Promise<CollectedStep> {
	const out: CollectedStep = {
		text: "",
		calls: [],
		usage: null,
		started: false,
		error: null,
	};
	try {
		for await (const part of client.step(req)) {
			out.started = true;
			if (part.type === "text") out.text += part.text;
			else if (part.type === "tool-call")
				out.calls.push({ id: part.id, name: part.name, input: part.input });
			else out.usage = part.usage;
		}
	} catch (error) {
		out.error = toModelError(error, req.signal);
	}
	return out;
}

/** Add one step's tokens to a running total. */
export function addUsage(total: StepUsage, part: StepUsage): void {
	total.input += part.input;
	total.output += part.output;
	total.cacheRead += part.cacheRead;
	total.cacheWrite += part.cacheWrite;
}
