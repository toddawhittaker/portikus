import {
	ApiKey,
	ApiKeyActionResult,
	ApiKeyList,
	type CreateApiKeyRequest,
	CreatedApiKey,
	PasskeyOptions,
} from "@portikus/contracts";
import {
	type PublicKeyCredentialRequestOptionsJSON,
	startAuthentication,
} from "@simplewebauthn/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request, sendJson } from "../api/request.js";

/** The owner's own API keys (SPEC.md sections 24.8 and 24.13). */

const MY_API_KEYS = ["me", "api-keys"];

/** The fields the create form fills; the second-factor proof is added per path. */
export type NewApiKey = Pick<CreateApiKeyRequest, "name" | "scope" | "periodDays">;

export function useMyApiKeys() {
	return useQuery({
		queryKey: MY_API_KEYS,
		queryFn: () => request(ApiKeyList, "/me/api-keys"),
	});
}

/** Run a key change, then reload the list so every row shows the server's state. */
function useKeyMutation<T, V>(mutationFn: (variables: V) => Promise<T>) {
	const client = useQueryClient();
	return useMutation({
		mutationFn,
		onSettled: () => client.invalidateQueries({ queryKey: MY_API_KEYS, exact: true }),
	});
}

/** Create with an authenticator or recovery code, or none for an account that owes no check. */
export function useCreateApiKey() {
	return useKeyMutation((body: NewApiKey & { code?: string }) =>
		sendJson(CreatedApiKey, "/me/api-keys", body),
	);
}

/** Create after proving one of the account's passkeys (SPEC.md section 24.13). */
export function useCreateApiKeyWithPasskey() {
	return useKeyMutation(async (fields: NewApiKey) => {
		const options = await sendJson(PasskeyOptions, "/me/api-keys/passkey/start", {});
		const credential = await startAuthentication({
			optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
		});
		return sendJson(CreatedApiKey, "/me/api-keys", { ...fields, credential });
	});
}

/** Restart the key's period, keeping its secret. */
export function useRenewApiKey() {
	return useKeyMutation((id: string) =>
		sendJson(ApiKey, `/me/api-keys/${id}/renew`, {}),
	);
}

/** Restart the key's period with a new secret; the old one stops working. */
export function useRotateApiKey() {
	return useKeyMutation((id: string) =>
		sendJson(CreatedApiKey, `/me/api-keys/${id}/rotate`, {}),
	);
}

export function useRevokeApiKey() {
	return useKeyMutation((id: string) =>
		sendJson(ApiKeyActionResult, `/me/api-keys/${id}/revoke`, {}),
	);
}
