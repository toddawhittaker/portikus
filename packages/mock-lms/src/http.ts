import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 64 * 1024;

export function send(res: ServerResponse, status: number, type: string, body: string) {
	res.writeHead(status, {
		"content-type": type,
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
	});
	res.end(body);
}

export const html = (res: ServerResponse, status: number, body: string) =>
	send(res, status, "text/html; charset=utf-8", body);

export const json = (res: ServerResponse, status: number, body: unknown) =>
	send(res, status, "application/json", JSON.stringify(body));

export async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) throw new Error("body too large");
		chunks.push(chunk as Buffer);
	}
	return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}
