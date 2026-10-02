import { pipeline, Readable, Transform } from "node:stream";
import { MAX_DOWNLOAD_BYTES, ZIP_OVERHEAD_BYTES } from "@portikus/contracts";

/** The most bytes the API relays for one download, whatever the agent sends. */
export const DOWNLOAD_RELAY_LIMIT = MAX_DOWNLOAD_BYTES + ZIP_OVERHEAD_BYTES;

/**
 * A download body cut off at DOWNLOAD_RELAY_LIMIT. The agent refuses a
 * download over the cap before sending anything, so only a misbehaving
 * agent reaches this; the browser then sees a failed download.
 */
export function cappedDownload(body: ReadableStream<Uint8Array>): Readable {
	let sent = 0;
	const counter = new Transform({
		transform(chunk: Buffer, _encoding, done) {
			sent += chunk.length;
			if (sent > DOWNLOAD_RELAY_LIMIT) {
				done(new Error("download passed the size cap"));
				return;
			}
			done(null, chunk);
		},
	});
	// pipeline tears down the agent's stream too, so the fetch is cancelled.
	pipeline(Readable.fromWeb(body as never), counter, () => {});
	return counter;
}
