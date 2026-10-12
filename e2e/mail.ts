import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { API_PORT } from "./ports";

/**
 * Account email the e2e API captured instead of sending (MAIL_CAPTURE_FILE,
 * SPEC.md section 5.3): one nodemailer JSON message per line. Keyed by the
 * API's port so two runs on one host keep apart.
 */
export const MAIL_CAPTURE_FILE = join(tmpdir(), `portikus-e2e-mail-${API_PORT}.jsonl`);

interface CapturedMail {
	to: string[];
	subject: string;
	text: string;
}

async function readMail(): Promise<CapturedMail[]> {
	let text: string;
	try {
		text = await readFile(MAIL_CAPTURE_FILE, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw e;
	}
	return text
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => {
			// nodemailer's jsonTransport writes the recipients as address objects.
			const message = JSON.parse(line) as {
				to: { address: string }[];
				subject: string;
				text: string;
			};
			return {
				to: message.to.map((a) => a.address),
				subject: message.subject,
				text: message.text,
			};
		});
}

/**
 * Forget every captured message, so a test reads only its own.
 * @public: for the emailed reset specs.
 */
export async function clearMail(): Promise<void> {
	await rm(MAIL_CAPTURE_FILE, { force: true });
}

/**
 * Wait for the newest message to `address` and return the first link in it.
 */
export async function findMailLink(address: string): Promise<string> {
	let link = "";
	await expect
		.poll(
			async () => {
				const mine = (await readMail()).filter((mail) => mail.to.includes(address));
				link = mine.at(-1)?.text.match(/https?:\/\/\S+/)?.[0] ?? "";
				return link;
			},
			{ timeout: 15_000 },
		)
		.not.toBe("");
	return link;
}
