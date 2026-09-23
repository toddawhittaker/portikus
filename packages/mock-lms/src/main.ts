import { createServer } from "node:http";
import { parseArgs, USAGE } from "./cli.js";
import { createHandler, registration } from "./server.js";
import { createSigner } from "./token.js";

let options: ReturnType<typeof parseArgs>;
try {
	options = parseArgs(process.argv.slice(2));
} catch (error) {
	process.stderr.write(`${(error as Error).message}\n${USAGE}\n`);
	process.exit(2);
}

const signer = await createSigner();
const handler = createHandler({
	issuer: options.issuer,
	toolUrl: options.toolUrl,
	signer,
	log: (line) => process.stdout.write(`${line}\n`),
});

for (const bind of options.binds) {
	const server = createServer((req, res) => void handler(req, res));
	server.on("error", (error) => {
		process.stderr.write(
			`cannot listen on ${bind}:${options.port}: ${error.message}\n`,
		);
		process.exit(1);
	});
	server.listen(options.port, bind, () => {
		process.stdout.write(`mock LMS listening on http://${bind}:${options.port}/\n`);
	});
}

process.stdout.write(
	`Registration for the platforms file:\n${JSON.stringify(registration(options.issuer), null, 2)}\n`,
);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
