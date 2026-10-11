export interface CliOptions {
	port: number;
	binds: string[];
	toolUrl: string;
	issuer: string;
	/** Certificate and key files; with them the mock serves https. */
	tls?: { certFile: string; keyFile: string };
	/** The tool's keyset as a file, for a mock that cannot reach the tool's /lti/jwks. */
	toolKeysFile?: string;
}

export const USAGE =
	"Usage: node packages/mock-lms/dist/main.js --tool-url <Portikus URL> [--port 8765] [--bind <address>]... [--issuer <URL>] [--tls-cert <file> --tls-key <file>] [--tool-keys-file <file>]";

const FLAGS = new Set([
	"--port",
	"--bind",
	"--tool-url",
	"--issuer",
	"--tls-cert",
	"--tls-key",
	"--tool-keys-file",
]);

/** Each flag's last value, and every --bind in order. */
function readFlags(argv: string[]): { values: Map<string, string>; binds: string[] } {
	const values = new Map<string, string>();
	const binds: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i] as string;
		// pnpm passes a lone "--" through to the script.
		if (flag === "--") continue;
		const value = argv[i + 1];
		if (value === undefined) throw new Error(`${flag} needs a value`);
		i++;
		if (!FLAGS.has(flag)) throw new Error(`unknown flag ${flag}`);
		if (flag === "--bind") binds.push(value);
		else values.set(flag, value);
	}
	return { values, binds };
}

function readPort(value: string | undefined): number {
	if (value === undefined) return 8765;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error("--port must be 1 to 65535");
	}
	return port;
}

function readTls(values: Map<string, string>): CliOptions["tls"] {
	const certFile = values.get("--tls-cert");
	const keyFile = values.get("--tls-key");
	if ((certFile === undefined) !== (keyFile === undefined)) {
		throw new Error("--tls-cert and --tls-key go together");
	}
	return certFile !== undefined && keyFile !== undefined
		? { certFile, keyFile }
		: undefined;
}

export function parseArgs(argv: string[]): CliOptions {
	const { values, binds } = readFlags(argv);
	const port = readPort(values.get("--port"));
	const toolUrlValue = values.get("--tool-url");
	if (toolUrlValue === undefined) throw new Error("--tool-url is required");
	const toolUrl = httpUrl(toolUrlValue, "--tool-url");
	const issuerValue = values.get("--issuer");
	const issuer =
		issuerValue === undefined ? undefined : httpUrl(issuerValue, "--issuer");
	const tls = readTls(values);
	const scheme = tls ? "https" : "http";
	if (issuer !== undefined && new URL(issuer).protocol !== `${scheme}:`) {
		// The issuer names the URLs the platforms file registers, so they must match what is served.
		throw new Error(
			tls
				? "--issuer must be https when --tls-cert is given"
				: "an https --issuer needs --tls-cert and --tls-key",
		);
	}
	if (binds.length === 0) binds.push("127.0.0.1");
	const first = binds[0] as string;
	const host = first.includes(":") ? `[${first}]` : first;
	const toolKeysFile = values.get("--tool-keys-file");
	return {
		port,
		binds,
		toolUrl,
		issuer: issuer ?? `${scheme}://${host}:${port}`,
		...(tls ? { tls } : {}),
		...(toolKeysFile !== undefined ? { toolKeysFile } : {}),
	};
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
