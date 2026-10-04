import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time codes, RFC 6238 with the parameters every
 * authenticator app supports: HMAC-SHA-1, 6 digits, 30-second steps
 * (SPEC.md section 24.13).
 */
const STEP_SECONDS = 30;
const DIGITS = 6;
/** One step either side, for clock drift between the phone and the server. */
const DRIFT_STEPS = 1;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
	return out;
}

export function base32Decode(text: string): Buffer {
	const clean = text.replace(/[\s=]/g, "").toUpperCase();
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const char of clean) {
		const index = BASE32.indexOf(char);
		if (index < 0) throw new Error("not base32");
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

/** A new 160-bit secret, the size RFC 4226 recommends for SHA-1. */
export function generateTotpSecret(): Buffer {
	return randomBytes(20);
}

/** The time step a moment falls in. */
export function totpStep(nowMs: number): number {
	return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/** The code for one time step (RFC 4226 dynamic truncation). */
export function totpCode(secret: Buffer, step: number): string {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(step));
	const mac = createHmac("sha1", secret).update(counter).digest();
	const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
	const binary = mac.readUInt32BE(offset) & 0x7fffffff;
	return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * The step whose code matches, within the drift window and later than
 * `lastStep`, so an accepted code never works twice. Null when none does.
 */
export function matchTotp(
	secret: Buffer,
	code: string,
	nowMs: number,
	lastStep: number | null,
): number | null {
	if (!/^\d{6}$/.test(code)) return null;
	const now = totpStep(nowMs);
	for (let step = now - DRIFT_STEPS; step <= now + DRIFT_STEPS; step++) {
		if (lastStep !== null && step <= lastStep) continue;
		if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(code))) {
			return step;
		}
	}
	return null;
}

/** The `otpauth://` URI an authenticator app reads from the QR code. */
export function otpauthUri(secret: Buffer, issuer: string, account: string): string {
	const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
	const params = new URLSearchParams({
		secret: base32Encode(secret),
		issuer,
		algorithm: "SHA1",
		digits: String(DIGITS),
		period: String(STEP_SECONDS),
	});
	return `otpauth://totp/${label}?${params.toString()}`;
}
