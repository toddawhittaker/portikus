import type { Readable } from "node:stream";

/**
 * A web ReadableStream over a Node Readable, for a fetch Response or request
 * body. Node's own `Readable.toWeb` must not be used for these: cancelling
 * its stream while a read is pending lets the Node stream emit one more
 * chunk into the closed stream, which throws from a bare tick and kills the
 * process (seen with Node 24 and 26). Here every chunk is read on demand,
 * so nothing is pushed after a cancel.
 */
export function readableToWeb(source: Readable): ReadableStream<Uint8Array> {
	// Errors reach the reader through the iterator; without this listener the
	// destroy a cancel causes would be an unhandled 'error' event.
	source.on("error", () => {});
	const chunks = source[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await chunks.next();
			if (done) {
				controller.close();
				return;
			}
			// A copy, so the reader never holds a view into a shared Buffer pool.
			controller.enqueue(new Uint8Array(value as Buffer));
		},
		cancel(reason) {
			source.destroy(reason instanceof Error ? reason : undefined);
		},
	});
}
