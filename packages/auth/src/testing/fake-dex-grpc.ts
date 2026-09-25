import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import bcrypt from "bcryptjs";

/**
 * A stand-in for Dex's gRPC API with mutual TLS, holding passwords in
 * memory: for the dex-api unit tests and the browser tests (e2e/fake-dex-grpc.mjs).
 */

const PROTO_PATH = fileURLToPath(new URL("../../proto/dex-api.proto", import.meta.url));

/** File paths of a throwaway certificate authority and its two certificates. */
export interface DexGrpcCerts {
	ca: string;
	caKey: string;
	serverCert: string;
	serverKey: string;
	clientCert: string;
	clientKey: string;
}

function openssl(dir: string, args: string[]): void {
	execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
}

function issue(
	dir: string,
	name: string,
	ca: string,
	caKey: string,
	ext: string,
): void {
	openssl(dir, [
		"req",
		"-newkey",
		"ec",
		"-pkeyopt",
		"ec_paramgen_curve:P-256",
		"-nodes",
		"-keyout",
		`${name}.key`,
		"-out",
		`${name}.csr`,
		"-subj",
		`/CN=${name}`,
	]);
	writeFileSync(join(dir, `${name}.ext`), `${ext}\n`);
	openssl(dir, [
		"x509",
		"-req",
		"-in",
		`${name}.csr`,
		"-CA",
		ca,
		"-CAkey",
		caKey,
		"-CAcreateserial",
		"-days",
		"2",
		"-out",
		`${name}.crt`,
		"-extfile",
		`${name}.ext`,
	]);
}

/**
 * Make a certificate authority, a server certificate for 127.0.0.1, and a
 * client certificate in `dir` with the openssl command. Files already there
 * are kept, so several processes can share one directory.
 */
export function writeDexGrpcCerts(dir: string, name = "test"): DexGrpcCerts {
	mkdirSync(dir, { recursive: true });
	const certs: DexGrpcCerts = {
		ca: join(dir, `${name}-ca.crt`),
		caKey: join(dir, `${name}-ca.key`),
		serverCert: join(dir, `${name}-server.crt`),
		serverKey: join(dir, `${name}-server.key`),
		clientCert: join(dir, `${name}-client.crt`),
		clientKey: join(dir, `${name}-client.key`),
	};
	if (existsSync(certs.clientCert)) return certs;
	openssl(dir, [
		"req",
		"-x509",
		"-newkey",
		"ec",
		"-pkeyopt",
		"ec_paramgen_curve:P-256",
		"-nodes",
		"-keyout",
		certs.caKey,
		"-out",
		certs.ca,
		"-days",
		"2",
		"-subj",
		`/CN=${name}-ca`,
	]);
	issue(
		dir,
		`${name}-server`,
		certs.ca,
		certs.caKey,
		"subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth",
	);
	issue(dir, `${name}-client`, certs.ca, certs.caKey, "extendedKeyUsage=clientAuth");
	return certs;
}

interface StoredPassword {
	email: string;
	hash: Buffer;
	username: string;
	user_id: string;
}

export interface FakeDexGrpc {
	address: string;
	/** The passwords held, by email, with their hashes. */
	passwords: Map<string, StoredPassword>;
	/** When set, every call fails with UNAVAILABLE. */
	failing: boolean;
	/** How many VerifyPassword calls arrived. */
	readonly verifyCalls: number;
	close(): Promise<void>;
}

type Handler<Req, Res> = (
	call: { request: Req },
	callback: (error: grpc.ServiceError | null, value?: Res) => void,
) => void;

/** Serve the fake on 127.0.0.1, requiring a client certificate from the same authority. */
export async function startFakeDexGrpc(
	certs: DexGrpcCerts,
	port = 0,
): Promise<FakeDexGrpc> {
	const definition = protoLoader.loadSync(PROTO_PATH, {
		keepCase: true,
		longs: String,
		defaults: true,
	});
	const api = grpc.loadPackageDefinition(definition).api as unknown as {
		Dex: { service: grpc.ServiceDefinition };
	};
	const passwords = new Map<string, StoredPassword>();
	const fake = { failing: false, verifyCalls: 0 };
	const unavailable = {
		code: grpc.status.UNAVAILABLE,
		details: "the fake is failing on purpose",
	} as grpc.ServiceError;

	function handle<Req, Res>(run: (request: Req) => Res): Handler<Req, Res> {
		return (call, callback) => {
			if (fake.failing) callback(unavailable);
			else callback(null, run(call.request));
		};
	}

	const server = new grpc.Server();
	server.addService(api.Dex.service, {
		CreatePassword: handle((request: { password: StoredPassword }) => {
			const email = request.password.email.toLowerCase();
			if (passwords.has(email)) return { already_exists: true };
			passwords.set(email, { ...request.password, email });
			return { already_exists: false };
		}),
		UpdatePassword: handle(
			(request: { email: string; new_hash: Buffer; new_username: string }) => {
				const stored = passwords.get(request.email.toLowerCase());
				if (!stored) return { not_found: true };
				if (request.new_hash.length > 0) stored.hash = request.new_hash;
				if (request.new_username) stored.username = request.new_username;
				return { not_found: false };
			},
		),
		DeletePassword: handle((request: { email: string }) => ({
			not_found: !passwords.delete(request.email.toLowerCase()),
		})),
		VerifyPassword: handle((request: { email: string; password: string }) => {
			fake.verifyCalls += 1;
			const stored = passwords.get(request.email.toLowerCase());
			if (!stored) return { verified: false, not_found: true };
			const hash = stored.hash.toString("utf8");
			return { verified: bcrypt.compareSync(request.password, hash), not_found: false };
		}),
		ListPasswords: handle(() => ({
			passwords: [...passwords.values()].map((p) => ({ ...p, hash: Buffer.alloc(0) })),
		})),
	});
	const credentials = grpc.ServerCredentials.createSsl(
		readFileSync(certs.ca),
		[
			{
				cert_chain: readFileSync(certs.serverCert),
				private_key: readFileSync(certs.serverKey),
			},
		],
		true,
	);
	const bound = await new Promise<number>((resolve, reject) => {
		server.bindAsync(`127.0.0.1:${port}`, credentials, (error, actual) =>
			error ? reject(error) : resolve(actual),
		);
	});
	return {
		address: `127.0.0.1:${bound}`,
		passwords,
		get failing() {
			return fake.failing;
		},
		set failing(value: boolean) {
			fake.failing = value;
		},
		get verifyCalls() {
			return fake.verifyCalls;
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.tryShutdown(() => resolve());
			}),
	};
}
