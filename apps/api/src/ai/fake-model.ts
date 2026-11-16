import {
	type ModelClient,
	ModelError,
	type ModelErrorCode,
	type ModelPart,
	type StepRequest,
} from "./model.js";

/** One scripted step: the parts to replay, or an error code to throw instead. */
export type FakeStep = ModelPart[] | { error: ModelErrorCode };

export type FakeModelClient = ModelClient & {
	/** Every request `step` was given, in order. */
	readonly requests: StepRequest[];
};

/**
 * A model client for tests: replays scripted steps in order and records each
 * request. A step past the end of the script throws, so a test sees an
 * unexpected extra model call.
 */
export function createFakeModelClient(
	steps: FakeStep[],
	models: string[] | null = null,
): FakeModelClient {
	const requests: StepRequest[] = [];
	return {
		requests,
		async *step(req) {
			const index = requests.length;
			requests.push(req);
			const step = steps[index];
			if (step === undefined)
				throw new Error(`The fake model has no step ${index + 1}.`);
			if (!Array.isArray(step)) throw new ModelError(step.error);
			for (const part of step) {
				if (req.signal.aborted) throw new ModelError("aborted");
				yield part;
			}
		},
		listModels: async () => models,
	};
}
