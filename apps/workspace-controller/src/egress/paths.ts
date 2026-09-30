/** The file interface between the controller, the root helper and Ansible (ADR 0038). */
export const EGRESS_PATHS = {
	/** Written by the controller; directory root:portikus-controller 0770. */
	request: "/var/lib/portikus/egress-request/request.json",
	/** Root-owned; the helper's own files. */
	stateDir: "/var/lib/portikus/egress-state",
	/** Root-owned, written by Ansible. */
	env: "/etc/portikus/egress.env",
	/** Root-owned, written by the registry cache helper: "on" while the ghcr.io cache runs. */
	ghcrEnabled: "/etc/portikus/registry/ghcr-enabled",
} as const;

/** File names inside the state directory. */
export const STATE_FILES = {
	applied: "applied.json",
	status: "status.json",
	names: "names.txt",
	/** Blocked sites for Squid, open mode only (ADR 0043). */
	blocked: "blocked.txt",
	/** Squid's open-mode switch: "." while open mode has blocked sites. */
	open: "open.txt",
	dnsmasq: "dnsmasq.conf",
	/** Where the helper moves a request before reading it. */
	processing: "request.processing",
} as const;

/** The two services the helper may reload, restart or stop, and nothing else. */
export const EGRESS_DNS_UNIT = "portikus-egress-dns.service";
export const WORKSPACE_PROXY_UNIT = "portikus-workspace-proxy.service";
