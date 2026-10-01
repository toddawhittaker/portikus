import { createHash } from "node:crypto";

/** SHA-256 of a secret as lowercase hex, so only the hash is ever stored. */
export function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
