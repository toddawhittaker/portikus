import type { AuthInfo, McpHttpHandler } from "@modelcontextprotocol/server";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Headers the MCP handler never needs. The key and the cookie stay out of the
 * SDK, and the body is sent again from what Fastify parsed, so its length and
 * framing are recomputed.
 */
const DROPPED = new Set([
	"authorization",
	"cookie",
	"content-length",
	"transfer-encoding",
	"connection",
]);

/**
 * Serve one MCP request through the SDK's web-standard handler. Fastify has
 * already read and parsed the body, so the handler gets it both re-encoded
 * and as `parsedBody`; Fastify 5 sends the returned `Response`, streaming
 * its body when the handler answers with a stream.
 */
export async function serveMcp(
	handler: McpHttpHandler,
	request: FastifyRequest,
	reply: FastifyReply,
	options: { origin: string; authInfo: AuthInfo },
): Promise<FastifyReply> {
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers)) {
		if (value === undefined || DROPPED.has(name)) continue;
		for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
	}
	const hasBody = request.method === "POST" && request.body !== undefined;
	const webRequest = new Request(new URL(request.url, options.origin), {
		method: request.method,
		headers,
		...(hasBody ? { body: JSON.stringify(request.body) } : {}),
	});
	const response = await handler.fetch(webRequest, {
		authInfo: options.authInfo,
		...(hasBody ? { parsedBody: request.body } : {}),
	});
	return reply.send(response);
}
