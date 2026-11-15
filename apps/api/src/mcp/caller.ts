import type { AuthInfo } from "@modelcontextprotocol/server";
import type { Role } from "@portikus/auth";
import type { ApiKeyScope } from "@portikus/contracts";
import { riskWithinScope } from "../api-keys/scope.js";
import type { Operation } from "../catalog/index.js";
import type { RunCaller } from "../catalog/run.js";

/** The key holder an MCP request runs as, carried to the server factory in `authInfo`. */
export interface McpCaller extends RunCaller {
	userId: string;
	keyId: string;
	scope: ApiKeyScope;
	role: Role;
}

export function toAuthInfo(caller: McpCaller): AuthInfo {
	return {
		token: caller.apiKey,
		clientId: caller.keyId,
		scopes: [caller.scope],
		extra: {
			userId: caller.userId,
			role: caller.role,
			ip: caller.ip,
			userAgent: caller.userAgent,
		},
	};
}

/** The caller the `/mcp` route put in `authInfo`; anything else is a wiring fault. */
export function fromAuthInfo(authInfo: AuthInfo | undefined): McpCaller {
	const extra = authInfo?.extra;
	const scope = authInfo?.scopes[0];
	if (
		!authInfo ||
		!extra ||
		!scope ||
		typeof extra.ip !== "string" ||
		typeof extra.userId !== "string"
	) {
		throw new Error("an MCP request arrived without its key holder");
	}
	return {
		apiKey: authInfo.token,
		userId: extra.userId,
		keyId: authInfo.clientId,
		scope: scope as ApiKeyScope,
		role: extra.role as Role,
		ip: extra.ip,
		...(typeof extra.userAgent === "string" ? { userAgent: extra.userAgent } : {}),
	};
}

/** Whether the operation's audience takes in this role. */
function inAudience(operation: Operation, role: Role): boolean {
	if (operation.audience === "staff")
		return role === "administrator" || role === "instructor";
	return operation.audience === role;
}

/**
 * Whether this key may run the operation: its audience takes in the owner's
 * role and its risk is within the key's scope (SPEC.md section 24.13).
 */
export function mayRun(
	operation: Operation,
	caller: Pick<McpCaller, "role" | "scope">,
): boolean {
	return (
		inAudience(operation, caller.role) && riskWithinScope(operation.risk, caller.scope)
	);
}
