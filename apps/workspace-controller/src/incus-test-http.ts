import type * as http from "node:http";

/** Replies shaped like the Incus REST API, for tests that fake it on a socket. */

export function respond(res: http.ServerResponse, status: number, body: unknown): void {
	// Incus sends an ETag on every instance read; the start's allowance check needs one.
	res.writeHead(status, { "Content-Type": "application/json", ETag: '"e1"' });
	res.end(JSON.stringify(body));
}

export function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString()));
	});
}

export function runningWithAddress(address: string) {
	return {
		status: "Running",
		network: {
			eth0: {
				addresses: [{ family: "inet", address, scope: "global" }],
			},
		},
	};
}

export function sync(metadata: unknown) {
	return {
		type: "sync",
		status: "Success",
		status_code: 200,
		metadata,
	};
}

export function incusError(
	res: http.ServerResponse,
	code: number,
	error: string,
): void {
	respond(res, code, {
		type: "error",
		status: "Failure",
		status_code: code,
		error,
		error_code: code,
	});
}
