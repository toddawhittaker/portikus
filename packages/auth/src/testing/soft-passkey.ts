import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type {
	AuthenticationResponseJSON,
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
	RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_DATA = 0x40;

function sha256(data: Buffer): Buffer {
	return createHash("sha256").update(data).digest();
}

/**
 * A software passkey for tests (SPEC.md section 24.13): one P-256 key that
 * answers registration and sign-in options the way a browser and
 * authenticator would, with "none" attestation. `counter` is public so a
 * test can play a copied key that reports an old count.
 */
export class SoftPasskey {
	readonly credentialId = randomBytes(16).toString("base64url");
	counter = 0;
	private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });

	/** `origin` is what the browser would report; the RP ID comes from the options. */
	constructor(private readonly origin: string) {}

	private clientData(type: string, challenge: string, origin: string): Buffer {
		return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
	}

	private authData(rpId: string, extra: Buffer = Buffer.alloc(0)): Buffer {
		const count = Buffer.alloc(4);
		count.writeUInt32BE(this.counter);
		const flags =
			FLAG_USER_PRESENT |
			FLAG_USER_VERIFIED |
			(extra.length > 0 ? FLAG_ATTESTED_DATA : 0);
		return Buffer.concat([
			sha256(Buffer.from(rpId)),
			Buffer.from([flags]),
			count,
			extra,
		]);
	}

	register(
		options: PublicKeyCredentialCreationOptionsJSON,
		origin: string = this.origin,
	): RegistrationResponseJSON {
		const jwk = this.keys.publicKey.export({ format: "jwk" });
		const coseKey = new Map<number, number | Uint8Array>([
			[1, 2],
			[3, -7],
			[-1, 1],
			[-2, Buffer.from(jwk.x as string, "base64url")],
			[-3, Buffer.from(jwk.y as string, "base64url")],
		]);
		const id = Buffer.from(this.credentialId, "base64url");
		const idLength = Buffer.alloc(2);
		idLength.writeUInt16BE(id.length);
		const attested = Buffer.concat([
			Buffer.alloc(16),
			idLength,
			id,
			Buffer.from(isoCBOR.encode(coseKey)),
		]);
		const attestationObject = isoCBOR.encode(
			new Map<string, string | Map<string, never> | Uint8Array>([
				["fmt", "none"],
				["attStmt", new Map<string, never>()],
				["authData", this.authData(options.rp.id ?? "", attested)],
			]),
		);
		return {
			id: this.credentialId,
			rawId: this.credentialId,
			type: "public-key",
			clientExtensionResults: {},
			response: {
				clientDataJSON: this.clientData(
					"webauthn.create",
					options.challenge,
					origin,
				).toString("base64url"),
				attestationObject: Buffer.from(attestationObject).toString("base64url"),
				transports: ["internal"],
			},
		};
	}

	/** Sign in, counting up first as a real authenticator does. */
	authenticate(
		options: PublicKeyCredentialRequestOptionsJSON,
		origin: string = this.origin,
	): AuthenticationResponseJSON {
		this.counter += 1;
		const authenticatorData = this.authData(options.rpId ?? "");
		const clientDataJSON = this.clientData("webauthn.get", options.challenge, origin);
		const signature = sign(
			"sha256",
			Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
			this.keys.privateKey,
		);
		return {
			id: this.credentialId,
			rawId: this.credentialId,
			type: "public-key",
			clientExtensionResults: {},
			response: {
				clientDataJSON: clientDataJSON.toString("base64url"),
				authenticatorData: authenticatorData.toString("base64url"),
				signature: signature.toString("base64url"),
			},
		};
	}
}
