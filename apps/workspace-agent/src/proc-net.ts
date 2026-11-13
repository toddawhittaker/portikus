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
	const { start: bestStart, length: bestLength } = longestZeroRun(groups);
	if (bestLength < 2) return groups.join(":");
	const head = groups.slice(0, bestStart).join(":");
	const tail = groups.slice(bestStart + bestLength).join(":");
	return `${head}::${tail}`;
}

/** The longest run of "0" groups, the one `::` replaces; the first wins a tie. */
function longestZeroRun(groups: readonly string[]): { start: number; length: number } {
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
	return { start: bestStart, length: bestLength };
}

/** Parse the LISTEN rows out of a `/proc/net/tcp` or `tcp6` file. */
export function parseProcNetTcp(text: string): ProcListener[] {
	const listeners: ProcListener[] = [];
	for (const line of text.split("\n").slice(1)) {
		const listener = parseListenRow(line);
		if (listener) listeners.push(listener);
	}
	return listeners;
}

/** One row of the file, or null unless it is a well-formed LISTEN row. */
function parseListenRow(line: string): ProcListener | null {
	const fields = line.trim().split(/\s+/);
	// sl, local, remote, state, queues, timer, retransmit, uid, timeout, inode
	if (fields.length < 10) return null;
	if (fields[3] !== LISTEN_STATE) return null;
	const [hexAddress, hexPort] = (fields[1] ?? "").split(":");
	if (!hexAddress || !hexPort) return null;
	let address: string;
	try {
		address = decodeHexAddress(hexAddress);
	} catch {
		return null;
	}
	const port = Number.parseInt(hexPort, 16);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
	const uid = Number.parseInt(fields[7] ?? "", 10);
	return {
		address,
		port,
		inode: fields[9] ?? "",
		uid: Number.isInteger(uid) ? uid : -1,
	};
}
