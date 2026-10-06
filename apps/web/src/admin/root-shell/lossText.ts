/**
 * What the Root shell tab says when shells are gone without exiting: in the
 * pane, and once in the tab's status region for shells lost together.
 */
import type { RootShellLoss } from "./rootShellSocket.js";

/** What the pane says once its shell is gone without exiting. */
export const LOSS_TEXT: Record<RootShellLoss, string> = {
	too_many:
		"You have too many terminals open across your browser tabs. Close some terminals or root shells, then open a new root shell.",
	server_stopped:
		"Portikus restarted on the server, so this root shell ended. Close this pane and open a new root shell.",
	refused: "The root shell could not start on the host.",
	forbidden: "Your account is no longer an administrator, so this root shell ended.",
	closed:
		"This root shell's connection closed. Close this pane and open a new root shell.",
};

/**
 * One sentence for `count` shells lost together for `reason`, so a restart
 * that ends several shells is announced once (SPEC.md §25.8).
 */
export function lossSummary(reason: RootShellLoss, count: number): string {
	const one = count === 1;
	const shells = one ? "a root shell" : `${count} root shells`;
	const Shells = one ? "A root shell" : `${count} root shells`;
	switch (reason) {
		case "server_stopped":
			return `Portikus restarted, so ${shells} ended.`;
		case "too_many":
			return `${Shells} could not open because too many terminals are open.`;
		case "refused":
			return `${Shells} could not start on the host.`;
		case "forbidden":
			return LOSS_TEXT.forbidden;
		case "closed":
			return one
				? "A root shell's connection closed."
				: `${count} root shells' connections closed.`;
	}
}
