/**
 * The workspace outbound-limit lines the host firewall writes to the kernel
 * log (SPEC.md section 24.2). Only these prefixes are read; every other
 * kernel line is ignored, and of a matched line only the source address and
 * destination port are kept (docs/adr/0036).
 */
const KERNEL_LINES: Readonly<Record<string, { code: string; msg: string }>> = {
	"portikus-ws-mail-blocked: ": {
		code: "WORKSPACE_MAIL_BLOCKED",
		msg: "Workspace outbound mail blocked",
	},
	"portikus-ws-conn-limit: ": {
		code: "WORKSPACE_CONN_LIMIT",
		msg: "Workspace hit the new-connection limit",
	},
	"portikus-ws-packet-limit: ": {
		code: "WORKSPACE_PACKET_LIMIT",
		msg: "Workspace hit the packet limit",
	},
};

/** The prefixes as a `--grep` alternative; they hold no pattern characters. */
export const KERNEL_LINE_PATTERN = `^(${Object.keys(KERNEL_LINES).join("|")})`;

const SRC = /(?:^| )SRC=((?:[0-9]{1,3}\.){3}[0-9]{1,3})(?= |$)/;
const DPT = /(?:^| )DPT=([0-9]{1,5})(?= |$)/;

/**
 * A matched kernel MESSAGE as a Portikus JSON line, or null for any other
 * kernel line. `workspaceAddress` names the workspace until the API maps it.
 */
export function kernelLineMessage(message: string | null, at: Date): string | null {
	if (message === null) return null;
	const prefix = Object.keys(KERNEL_LINES).find((p) => message.startsWith(p));
	if (!prefix) return null;
	const { code, msg } = KERNEL_LINES[prefix] as { code: string; msg: string };
	const address = SRC.exec(message)?.[1];
	const port = DPT.exec(message)?.[1];
	return JSON.stringify({
		level: "warn",
		service: "network",
		time: at.toISOString(),
		code,
		msg,
		...(address ? { workspaceAddress: address } : {}),
		...(port ? { destinationPort: Number(port) } : {}),
	});
}
