export interface CliOptions {
	port: number;
	binds: string[];
	toolUrl: string;
	issuer: string;
}

export const USAGE =
	"Usage: node packages/mock-lms/dist/main.js --tool-url <Portikus URL> [--port 8765] [--bind <address>]... [--issuer <URL>]";

export function parseArgs(argv: string[]): CliOptions {
	let port = 8765;
	const binds: string[] = [];
	let toolUrl: string | undefined;
	let issuer: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		// pnpm passes a lone "--" through to the script.
		if (flag === "--") continue;
		const value = argv[i + 1];
		if (value === undefined) throw new Error(`${flag} needs a value`);
		i++;
		if (flag === "--port") {
			port = Number(value);
			if (!Number.isInteger(port) || port < 1 || port > 65535) {
				throw new Error("--port must be 1 to 65535");
			}
		} else if (flag === "--bind") {
			binds.push(value);
		} else if (flag === "--tool-url") {
			toolUrl = httpUrl(value, "--tool-url");
		} else if (flag === "--issuer") {
			issuer = httpUrl(value, "--issuer");
		} else {
			throw new Error(`unknown flag ${flag}`);
		}
	}
	if (toolUrl === undefined) throw new Error("--tool-url is required");
	if (binds.length === 0) binds.push("127.0.0.1");
	const first = binds[0] as string;
	const host = first.includes(":") ? `[${first}]` : first;
	return { port, binds, toolUrl, issuer: issuer ?? `http://${host}:${port}` };
}

function httpUrl(value: string, flag: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${flag} must be a URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`${flag} must be an http or https URL`);
	}
	return url.origin + url.pathname.replace(/\/+$/, "");
}
