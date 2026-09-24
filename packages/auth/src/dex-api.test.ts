import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	createDexApi,
	DEX_PASSWORD_LENGTH,
	type DexApi,
	generateDexPassword,
	hashDexPassword,
	loadDexApi,
} from "./dex-api.js";
import {
	type DexGrpcCerts,
	type FakeDexGrpc,
	startFakeDexGrpc,
	writeDexGrpcCerts,
} from "./testing/fake-dex-grpc.js";

let dir: string;
let certs: DexGrpcCerts;
let fake: FakeDexGrpc;
let dex: DexApi;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "dex-api-test-"));
	certs = writeDexGrpcCerts(dir);
	fake = await startFakeDexGrpc(certs);
	dex = createDexApi({
		address: fake.address,
		ca: readFileSync(certs.ca),
		cert: readFileSync(certs.clientCert),
		key: readFileSync(certs.clientKey),
	});
});

afterAll(async () => {
	dex.close();
	await fake.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("generated passwords", () => {
	test("are 20 characters from the unambiguous alphabet and differ each time", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 50; i++) {
			const password = generateDexPassword();
			expect(password).toHaveLength(DEX_PASSWORD_LENGTH);
			expect(password).toMatch(/^[A-HJ-NP-Za-km-np-z2-9]+$/);
			seen.add(password);
		}
		expect(seen.size).toBe(50);
	});

	test("hash with bcrypt at cost 10, the users file's rule", async () => {
		const hash = await hashDexPassword("a-password");
		expect(hash).toMatch(/^\$2[aby]\$10\$/);
		expect(await bcrypt.compare("a-password", hash)).toBe(true);
	});
});

describe("the gRPC client", () => {
	test("creates, lists, updates and deletes a password", async () => {
		const userId = crypto.randomUUID();
		expect(
			await dex.createPassword({
				email: "dana@example.edu",
				username: "dana",
				userId,
				hash: "$2b$10$first",
			}),
		).toBe("created");
		expect(fake.passwords.get("dana@example.edu")?.hash.toString()).toBe(
			"$2b$10$first",
		);
		expect(await dex.listPasswords()).toContainEqual({
			email: "dana@example.edu",
			username: "dana",
			userId,
		});

		expect(await dex.updatePassword("dana@example.edu", "$2b$10$second")).toBe(
			"updated",
		);
		const stored = fake.passwords.get("dana@example.edu");
		expect(stored?.hash.toString()).toBe("$2b$10$second");
		expect(stored?.username).toBe("dana");

		expect(await dex.deletePassword("dana@example.edu")).toBe("deleted");
		expect(fake.passwords.has("dana@example.edu")).toBe(false);
	});

	test("reports a taken email and a missing password", async () => {
		const input = {
			email: "twice@example.edu",
			username: "twice",
			userId: crypto.randomUUID(),
			hash: "$2b$10$x",
		};
		expect(await dex.createPassword(input)).toBe("created");
		expect(await dex.createPassword({ ...input, userId: crypto.randomUUID() })).toBe(
			"already_exists",
		);
		expect(await dex.updatePassword("nobody@example.edu", "$2b$10$y")).toBe(
			"not_found",
		);
		expect(await dex.deletePassword("nobody@example.edu")).toBe("not_found");
	});

	test("rejects when Dex fails", async () => {
		fake.failing = true;
		try {
			await expect(dex.listPasswords()).rejects.toThrow();
		} finally {
			fake.failing = false;
		}
	});

	test("a client without a certificate from Dex's authority is refused", async () => {
		const other = writeDexGrpcCerts(dir, "other");
		const stranger = createDexApi({
			address: fake.address,
			ca: readFileSync(certs.ca),
			cert: readFileSync(other.clientCert),
			key: readFileSync(other.clientKey),
		});
		try {
			await expect(stranger.listPasswords()).rejects.toThrow();
		} finally {
			stranger.close();
		}
	});
});

describe("loadDexApi", () => {
	test("is off when DEX_GRPC_ADDR is unset", async () => {
		expect(await loadDexApi({})).toBeNull();
	});

	test("needs all three files once the address is set", async () => {
		await expect(
			loadDexApi({ DEX_GRPC_ADDR: "127.0.0.1:5557", DEX_GRPC_CA: certs.ca }),
		).rejects.toThrow(/DEX_GRPC_CERT/);
	});

	test("reads the files and talks to Dex", async () => {
		const loaded = await loadDexApi({
			DEX_GRPC_ADDR: fake.address,
			DEX_GRPC_CA: certs.ca,
			DEX_GRPC_CERT: certs.clientCert,
			DEX_GRPC_KEY: certs.clientKey,
		});
		try {
			expect(Array.isArray(await loaded?.listPasswords())).toBe(true);
		} finally {
			loaded?.close();
		}
	});
});
