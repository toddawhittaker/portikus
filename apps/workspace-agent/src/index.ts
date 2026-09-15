/** Runs inside each user container (STACK.md section 10). Placeholder entrypoint; real behaviour arrives in a later epic. */
export const serviceName = "workspace-agent";

export function describeService(): string {
	return `portikus ${serviceName}`;
}

if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
	console.log(describeService());
}
