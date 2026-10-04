import type { BrowserContext } from "@playwright/test";
import { SoftPasskey } from "../packages/auth/dist/testing/soft-passkey.js";
import { WEB_ORIGIN } from "./ports";

export { SoftPasskey };

/**
 * Answer the page's WebAuthn calls with a software passkey (SPEC.md section
 * 24.13). Chromium refuses WebAuthn on an IP-address origin ("This is an
 * invalid domain"), and the suite runs on 127.0.0.1, so its virtual
 * authenticator cannot be used here. The page's `navigator.credentials`
 * hands the challenge to `key` in Node and gets back the same bytes a real
 * authenticator would make; the server checks them in full.
 */
export async function useSoftPasskey(
	context: BrowserContext,
	key: SoftPasskey,
): Promise<void> {
	await context.exposeFunction(
		"__softPasskey",
		(op: "create" | "get", options: string) => {
			const parsed = JSON.parse(options);
			return op === "create"
				? key.register(parsed, WEB_ORIGIN)
				: key.authenticate(parsed, WEB_ORIGIN);
		},
	);
	await context.addInitScript(() => {
		type Answer = {
			id: string;
			rawId: string;
			type: string;
			response: Record<string, string | string[]>;
		};
		const call = (
			window as unknown as {
				__softPasskey: (op: string, options: string) => Promise<Answer>;
			}
		).__softPasskey;
		const toText = (bytes: ArrayBuffer | ArrayBufferView): string => {
			const view =
				bytes instanceof ArrayBuffer
					? new Uint8Array(bytes)
					: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			return btoa(String.fromCharCode(...view))
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");
		};
		const toBytes = (text: string): ArrayBuffer =>
			Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
				c.charCodeAt(0),
			).buffer;
		const credential = (answer: Answer) => ({
			id: answer.id,
			rawId: toBytes(answer.rawId),
			type: answer.type,
			authenticatorAttachment: "platform",
			getClientExtensionResults: () => ({}),
			response: {
				clientDataJSON: toBytes(answer.response.clientDataJSON as string),
				...(answer.response.attestationObject
					? {
							attestationObject: toBytes(answer.response.attestationObject as string),
							getTransports: () => answer.response.transports,
						}
					: {
							authenticatorData: toBytes(answer.response.authenticatorData as string),
							signature: toBytes(answer.response.signature as string),
							userHandle: null,
						}),
			},
		});
		navigator.credentials.create = async (options) => {
			const publicKey = options?.publicKey as PublicKeyCredentialCreationOptions;
			const answer = await call(
				"create",
				JSON.stringify({ challenge: toText(publicKey.challenge), rp: publicKey.rp }),
			);
			return credential(answer) as unknown as Credential;
		};
		navigator.credentials.get = async (options) => {
			const publicKey = options?.publicKey as PublicKeyCredentialRequestOptions;
			const answer = await call(
				"get",
				JSON.stringify({
					challenge: toText(publicKey.challenge),
					rpId: publicKey.rpId,
				}),
			);
			return credential(answer) as unknown as Credential;
		};
	});
}
