/** Background job worker (STACK.md section 7). Placeholder entrypoint; real behaviour arrives in a later epic. */
export const serviceName = "worker";

export function describeService(): string {
	return `portikus ${serviceName}`;
}

if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
	console.log(describeService());
}
