/** The only process that talks to Incus (STACK.md section 9). Placeholder entrypoint; real behaviour arrives in a later epic. */
export const serviceName = "workspace-controller";

export function describeService(): string {
	return `portikus ${serviceName}`;
}

if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
	console.log(describeService());
}
