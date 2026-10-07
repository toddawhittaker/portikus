#!/usr/bin/env node
/**
 * Writes packages/auth/data/breached-passwords.txt from a pinned SecLists
 * list plus the project's hand-written entries (ADR 0054, SPEC.md section
 * 24.13). To refresh, bump the commit and checksum, then run:
 *   node scripts/generate-breached-passwords.mjs
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SECLISTS_COMMIT = "49c3b2d1d2481572bd7b0cb5af875a73cdf9d08e";
const SECLISTS_PATH =
	"Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt";
const SECLISTS_SHA256 =
	"424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51";
const SOURCE_URL = `https://raw.githubusercontent.com/danielmiessler/SecLists/${SECLISTS_COMMIT}/${SECLISTS_PATH}`;
const OUTPUT = fileURLToPath(
	new URL("../packages/auth/data/breached-passwords.txt", import.meta.url),
);

/** The new-password minimum length; shorter entries can never be chosen. */
export const MIN_LENGTH = 15;

/** Long passwords and patterns common in breach corpora, written for Portikus. */
export const HAND_WRITTEN = [
	"123456789012345",
	"1234567890123456",
	"12345678901234567890",
	"123456789123456",
	"111111111111111",
	"000000000000000",
	"987654321987654",
	"098765432109876",
	"147258369147258",
	"123123123123123",
	"121212121212121",
	"qwertyuiopasdfg",
	"qwertyuiopasdfgh",
	"qwertyuiopasdfghjkl",
	"qwertyuiopasdfghjklzxcvbnm",
	"qwertyuiop123456",
	"qwertyqwertyqwerty",
	"qwerty123456789",
	"qwertyuiop1234567890",
	"1234567890qwertyuiop",
	"1q2w3e4r5t6y7u8i",
	"1q2w3e4r5t6y7u8i9o",
	"1q2w3e4r5t6y7u8i9o0p",
	"q1w2e3r4t5y6u7i8",
	"1qaz2wsx3edc4rfv",
	"1qaz2wsx3edc4rfv5tgb",
	"zaq12wsxcde34rfv",
	"zxcvbnmasdfghjkl",
	"asdfghjklqwertyuiop",
	"asdfghjkl123456",
	"abcdefghijklmno",
	"abcdefghijklmnop",
	"abcdefghijklmnopqrstuvwxyz",
	"abcdefg123456789",
	"abc123abc123abc123",
	"passwordpassword",
	"password1234567",
	"password12345678",
	"password123456789",
	"passwordpassword123",
	"mypasswordis123",
	"thisismypassword",
	"thisismypassword1",
	"thisisapassword",
	"thisismynewpassword",
	"changemechangeme",
	"letmeinletmein1",
	"iloveyouiloveyou",
	"iloveyou1234567",
	"iloveyouforever",
	"iloveyoubaby123",
	"iloveyoumorethananything",
	"welcomewelcome1",
	"welcome12345678",
	"administrator123",
	"administrator1234",
	"adminadminadmin",
	"admin1234567890",
	"rootrootrootroot",
	"monkeymonkeymonkey",
	"dragondragondragon",
	"footballfootball",
	"baseballbaseball",
	"basketball12345",
	"superman12345678",
	"starwarsstarwars",
	"princessprincess",
	"sunshinesunshine",
	"trustno1trustno1",
	"masterkeymasterkey",
	"correcthorsebatterystaple",
	"correct horse battery staple",
	"thequickbrownfox",
	"thequickbrownfoxjumpsoverthelazydog",
	"the quick brown fox jumps over the lazy dog",
	"maytheforcebewithyou",
	"iamthegreatest1",
	"letmeinplease123",
	"opensesameopensesame",
	"supercalifragilisticexpialidocious",
	"aaaaaaaaaaaaaaa",
	"aaaaaaaaaaaaaaaa",
	"zzzzzzzzzzzzzzz",
	"xxxxxxxxxxxxxxx",
	"!@#$%^&*()!@#$%",
	"!@#$%^&*()_+1234",
	"1234567890!@#$%",
	"1234567890-=qwerty",
	"qazwsxedcrfvtgbyhn",
	"qazwsxedcrfvtgb",
	"mnbvcxzlkjhgfdsa",
	"poiuytrewqlkjhgfdsa",
	"0987654321poiuytrewq",
	"student123456789",
	"studentstudent1",
	"portikusportikus",
	"portikus12345678",
];

/** Lower-cases, drops entries under MIN_LENGTH, de-duplicates and sorts. */
export function buildList(sourceLines, extra) {
	const kept = new Set();
	for (const line of [...sourceLines, ...extra]) {
		// Strip only the line ending: a password may start or end with a space.
		const entry = line.replace(/\r$/, "").toLowerCase();
		if (entry.length >= MIN_LENGTH) kept.add(entry);
	}
	return [...kept].sort();
}

async function main() {
	const response = await fetch(SOURCE_URL);
	if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	if (sha256 !== SECLISTS_SHA256) {
		throw new Error(`checksum mismatch: expected ${SECLISTS_SHA256}, got ${sha256}`);
	}
	const list = buildList(bytes.toString("utf8").split("\n"), HAND_WRITTEN);
	await writeFile(OUTPUT, `${list.join("\n")}\n`);
	console.log(`wrote ${list.length} entries to ${OUTPUT}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
