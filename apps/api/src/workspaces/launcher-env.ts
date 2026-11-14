/**
 * The one institutional key this agent kind may receive (SPEC.md §10.6).
 * Only a variable this process actually has is forwarded, and only for the
 * launcher that uses it. The value is never stored or logged.
 */
function institutionalEnv(
	agent: "claude" | "codex" | undefined,
): { ANTHROPIC_API_KEY: string } | { OPENAI_API_KEY: string } | undefined {
	if (agent === "claude") {
		const key = process.env.ANTHROPIC_API_KEY;
		if (key) return { ANTHROPIC_API_KEY: key };
	}
	if (agent === "codex") {
		const key = process.env.OPENAI_API_KEY;
		if (key) return { OPENAI_API_KEY: key };
	}
	return undefined;
}

/**
 * The API does not choose the CLI. It forwards the launcher kind and, when
 * this process has it, the matching institutional key (SPEC.md §10.2,
 * §10.6, §24.8).
 */
export function launcherFields(agent: "claude" | "codex" | undefined) {
	const keys = institutionalEnv(agent);
	return {
		...(agent === undefined ? {} : { agent }),
		...(keys === undefined ? {} : { institutionalEnv: keys }),
	};
}
