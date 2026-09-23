/**
 * The journald command an administrator runs on the VM for one workspace's
 * log lines. The admin page shows no logs itself (ADR 0012; Epic 11 brief).
 */
export function logCommand(workspaceId: string, instanceName: string | null): string {
	const pattern = instanceName ? `${workspaceId}|${instanceName}` : workspaceId;
	return `journalctl -u portikus-api -u portikus-worker -u portikus-workspace-controller -o cat --since -1h | grep -E '${pattern}'`;
}
