import { PasskeyOptions, TotpEnrolDone } from "@portikus/contracts";
import {
	browserSupportsWebAuthn,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	startAuthentication,
	startRegistration,
} from "@simplewebauthn/browser";
import { z } from "zod";
import { ApiError, errorText, sendJson } from "../api/request.js";

/** Passkeys in the browser (SPEC.md section 24.13). */

export function passkeysSupported(): boolean {
	return browserSupportsWebAuthn();
}

/**
 * What to tell someone whose passkey attempt failed. The browser's own
 * errors, such as a cancelled prompt, are not in the user's terms.
 */
export function passkeyErrorText(failure: unknown): string {
	if (failure instanceof ApiError) return errorText(failure);
	return "The passkey was not used. Try again, or choose another way.";
}

/** Create a passkey and store it as a factor; returns the new recovery codes. */
export async function registerPasskey(): Promise<string[]> {
	const options = await sendJson(
		PasskeyOptions,
		"/me/second-factor/webauthn/start",
		{},
	);
	const credential = await startRegistration({
		optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
	});
	const done = await sendJson(TotpEnrolDone, "/me/second-factor/webauthn", {
		credential,
	});
	return done.recoveryCodes;
}

/** Pass the sign-in check with one of the account's passkeys. */
export async function verifyWithPasskey(): Promise<void> {
	const options = await sendJson(
		PasskeyOptions,
		"/me/second-factor/webauthn/verify/start",
		{},
	);
	const credential = await startAuthentication({
		optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
	});
	await sendJson(z.undefined(), "/me/second-factor/webauthn/verify", { credential });
}
