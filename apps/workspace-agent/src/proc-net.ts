/**
 * Parsing `/proc/net/tcp` and `/proc/net/tcp6` for listening sockets
 * (SPEC.md §14.7, §18.2).
 */

/** The TCP state `/proc` uses for a listening socket. */
const LISTEN_STATE = "0A";

/** One listening socket as `/proc/net/tcp` reports it. */
export interface ProcListener {
	address: string;
	port: number;
	inode: string;
	/** The account the socket belongs to; 0 is root. */
	uid: number;
}

/**
 * Decode one `/proc/net/tcp` address. Addresses are hexadecimal 32-bit words
 * in host byte order, so each group of four bytes is reversed: eight hex
 * digits for IPv4, thirty-two for IPv6.
 */
export function decodeHexAddress(hex: string): string {
	if (hex.length !== 8 && hex.length !== 32) {
		throw new Error(`unexpected address length: ${hex.length}`);
	}
	const bytes: number[] = [];
	for (let word = 0; word < hex.length / 8; word += 1) {
		const chunk = hex.slice(word * 8, word * 8 + 8);
		for (let byte = 3; byte >= 0; byte -= 1) {
			bytes.push(Number.parseInt(chunk.slice(byte * 2, byte * 2 + 2), 16));
		}
	}
	if (bytes.length === 4) return bytes.join(".");
	return formatIpv6(bytes);
}

/** Format sixteen bytes as an IPv6 address, with the usual `::` shortening. */
function formatIpv6(bytes: number[]): string {
	const groups: string[] = [];
	for (let index = 0; index < 16; index += 2) {
		groups.push((((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0)).toString(16));
	}
	// Find the longest run of zero groups to replace with "::".
	let bestStart = -1;
	let bestLength = 0;
	let runStart = -1;
	for (let index = 0; index <= groups.length; index += 1) {
		if (index < groups.length && groups[index] === "0") {
			if (runStart < 0) runStart = index;
			continue;
		}
		if (runStart >= 0) {
			const length = index - runStart;
			if (length > bestLength) {
				bestStart = runStart;
				bestLength = length;
			}
			runStart = -1;
		}
	}
	if (bestLength < 2) return groups.join(":");
	const head = groups.slice(0, bestStart).join(":");
	const tail = groups.slice(bestStart + bestLength).join(":");
	return `${head}::${tail}`;
}

/** Parse the LISTEN rows out of a `/proc/net/tcp` or `tcp6` file. */
export function parseProcNetTcp(text: string): ProcListener[] {
	const listeners: ProcListener[] = [];
	for (const line of text.split("\n").slice(1)) {
		const fields = line.trim().split(/\s+/);
		// sl, local, remote, state, queues, timer, retransmit, uid, timeout, inode
		if (fields.length < 10) continue;
		if (fields[3] !== LISTEN_STATE) continue;
		const [hexAddress, hexPort] = (fields[1] ?? "").split(":");
		if (!hexAddress || !hexPort) continue;
		let address: string;
		try {
			address = decodeHexAddress(hexAddress);
		} catch {
			continue;
		}
		const port = Number.parseInt(hexPort, 16);
		if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
		const uid = Number.parseInt(fields[7] ?? "", 10);
		listeners.push({
			address,
			port,
			inode: fields[9] ?? "",
			uid: Number.isInteger(uid) ? uid : -1,
		});
	}
	return listeners;
}
