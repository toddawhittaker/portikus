import { randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import bcrypt from "bcryptjs";

/**
 * A client for Dex's gRPC API, used to manage Dex's local passwords from the
 * admin area (docs/archive/epics/EPIC-14.md rulings 20 to 22, ADR 0028). The proto file is
 * Dex's api/v2/api.proto copied unchanged from the commit site.yml pins. It
 * lives outside src/ because the Debian package drops every src/ directory.
 *
 * A Dex password carries an email, a username and a user ID, and no display
 * name or groups: the name Dex gives is the username, and any role above
 * student has to be a Portikus grant.
 */

const PROTO_PATH = fileURLToPath(new URL("../proto/dex-api.proto", import.meta.url));

/** The users file's cost (dex_bcrypt_pattern); Dex refuses anything below 10. */
export const DEX_BCRYPT_COST = 10;

/** Length of a generated password. */
export const DEX_PASSWORD_LENGTH = 20;

// No 0/O, 1/l/I: the password is read off a screen and typed.
const READABLE_CHARACTERS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

/** How long one call may take before it fails. */
const CALL_TIMEOUT_MS = 10_000;

/** One Dex password, without its hash. */
export interface DexPassword {
	email: string;
	username: string;
	userId: string;
}

/** The Dex calls Portikus makes. Every method rejects when Dex cannot be reached. */
export interface DexApi {
	/** Create a password from a bcrypt hash; `already_exists` when the email is taken. */
	createPassword(
		input: DexPassword & { hash: string },
	): Promise<"created" | "already_exists">;
	/** Replace the hash of the password with this email. */
	updatePassword(email: string, hash: string): Promise<"updated" | "not_found">;
	/** Delete the password with this email. */
	deletePassword(email: string): Promise<"deleted" | "not_found">;
	/** Every password Dex holds. */
	listPasswords(): Promise<DexPassword[]>;
	/** Whether `password` is the one Dex holds for this email (SPEC.md section 5.3). */
	verifyPassword(
		email: string,
		password: string,
	): Promise<"verified" | "wrong" | "not_found">;
	close(): void;
}

/** Where the API finds Dex's gRPC port, and the mutual-TLS files for it. */
export interface DexApiConnection {
	address: string;
	ca: Buffer;
	cert: Buffer;
	key: Buffer;
}

/** A new random password for a Dex user; shown once and never stored by Portikus. */
export function generateDexPassword(): string {
	let out = "";
	for (let i = 0; i < DEX_PASSWORD_LENGTH; i++) {
		out += READABLE_CHARACTERS[randomInt(READABLE_CHARACTERS.length)];
	}
	return out;
}

/** The bcrypt hash Dex stores for a password. */
export function hashDexPassword(password: string): Promise<string> {
	return bcrypt.hash(password, DEX_BCRYPT_COST);
}

interface RawPassword {
	email: string;
	username: string;
	user_id: string;
}

type Callback<T> = (error: grpc.ServiceError | null, value?: T) => void;
type Method<Req, Res> = (
	request: Req,
	options: grpc.CallOptions,
	callback: Callback<Res>,
) => void;

interface RawDexClient extends grpc.Client {
	CreatePassword: Method<
		{ password: RawPassword & { hash: Buffer } },
		{ already_exists: boolean }
	>;
	UpdatePassword: Method<
		{ email: string; new_hash: Buffer; new_username: string },
		{ not_found: boolean }
	>;
	DeletePassword: Method<{ email: string }, { not_found: boolean }>;
	ListPasswords: Method<Record<string, never>, { passwords: RawPassword[] }>;
	VerifyPassword: Method<
		{ email: string; password: string },
		{ verified: boolean; not_found: boolean }
	>;
}

type ClientConstructor = new (
	address: string,
	credentials: grpc.ChannelCredentials,
	options: grpc.ChannelOptions,
) => RawDexClient;

function loadServiceClient(): ClientConstructor {
	const definition = protoLoader.loadSync(PROTO_PATH, {
		keepCase: true,
		longs: String,
		defaults: true,
	});
	const api = grpc.loadPackageDefinition(definition).api as unknown as {
		Dex: ClientConstructor;
	};
	return api.Dex;
}

function call<Req, Res>(client: RawDexClient, method: Method<Req, Res>, request: Req) {
	return new Promise<Res>((resolve, reject) => {
		method.call(
			client,
			request,
			{ deadline: Date.now() + CALL_TIMEOUT_MS },
			(error, value) => {
				if (error || value === undefined) reject(error ?? new Error("empty reply"));
				else resolve(value);
			},
		);
	});
}

/** A client that talks to Dex over mutual TLS. */
export function createDexApi(connection: DexApiConnection): DexApi {
	const Client = loadServiceClient();
	const client = new Client(
		connection.address,
		grpc.credentials.createSsl(connection.ca, connection.key, connection.cert),
		// Check the certificate against a name, not the IP, which Node warns about (DEP0123).
		{ "grpc.ssl_target_name_override": "localhost" },
	);
	return {
		async createPassword(input) {
			const res = await call(client, client.CreatePassword, {
				password: {
					email: input.email,
					username: input.username,
					user_id: input.userId,
					hash: Buffer.from(input.hash, "utf8"),
				},
			});
			return res.already_exists ? "already_exists" : "created";
		},
		async updatePassword(email, hash) {
			const res = await call(client, client.UpdatePassword, {
				email,
				new_hash: Buffer.from(hash, "utf8"),
				// Empty keeps the username.
				new_username: "",
			});
			return res.not_found ? "not_found" : "updated";
		},
		async deletePassword(email) {
			const res = await call(client, client.DeletePassword, { email });
			return res.not_found ? "not_found" : "deleted";
		},
		async listPasswords() {
			const res = await call(client, client.ListPasswords, {});
			return res.passwords.map((p) => ({
				email: p.email,
				username: p.username,
				userId: p.user_id,
			}));
		},
		async verifyPassword(email, password) {
			const res = await call(client, client.VerifyPassword, { email, password });
			if (res.not_found) return "not_found";
			return res.verified ? "verified" : "wrong";
		},
		close() {
			client.close();
		},
	};
}

/** The settings that turn the Dex user routes on (docs/archive/epics/EPIC-14.md, packages/config). */
export interface DexApiEnv {
	DEX_GRPC_ADDR?: string | undefined;
	DEX_GRPC_CA?: string | undefined;
	DEX_GRPC_CERT?: string | undefined;
	DEX_GRPC_KEY?: string | undefined;
}

/**
 * A client from the settings, or null when `DEX_GRPC_ADDR` is unset. With the
 * address set, all three files are required: Dex refuses a client without them.
 */
export async function loadDexApi(env: DexApiEnv): Promise<DexApi | null> {
	if (!env.DEX_GRPC_ADDR) return null;
	const { DEX_GRPC_CA: ca, DEX_GRPC_CERT: cert, DEX_GRPC_KEY: key } = env;
	if (!ca || !cert || !key) {
		throw new Error("DEX_GRPC_ADDR needs DEX_GRPC_CA, DEX_GRPC_CERT and DEX_GRPC_KEY");
	}
	return createDexApi({
		address: env.DEX_GRPC_ADDR,
		ca: await readFile(ca),
		cert: await readFile(cert),
		key: await readFile(key),
	});
}
