import type { ChatSignIn } from "@portikus/contracts";
import type { AppServerClient } from "./app-server.js";
import { AccountRead, AccountUpdated, parsed } from "./protocol.js";

/**
 * Whether the student is signed in to Codex, as its app-server says
 * (`account/read`). A Codex set up for a provider that needs no OpenAI
 * sign-in counts as signed in. An app-server that cannot answer, as an
 * older Codex may not, gives `unknown`.
 */
export async function readCodexSignIn(client: AppServerClient): Promise<ChatSignIn> {
	let account: AccountRead | null;
	try {
		account = parsed(AccountRead, await client.request("account/read", {}));
	} catch {
		return "unknown";
	}
	if (!account) return "unknown";
	return account.account !== null || !account.requiresOpenaiAuth
		? "signedIn"
		: "signedOut";
}

/** What an `account/updated` notification says, or null when it cannot be read. */
export function codexSignInUpdate(params: unknown): ChatSignIn | null {
	const update = parsed(AccountUpdated, params);
	if (!update) return null;
	return update.authMode === null ? "signedOut" : "signedIn";
}
