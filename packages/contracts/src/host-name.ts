import { z } from "zod";

// Labels of at most 63 characters, as the root alerts and site jobs check (ADRs 0052, 0059).
const HOST_NAME_RE =
	/^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** A host name the egress proxy may list: labels only, never an address. */
export function isHostName(value: string): boolean {
	return HOST_NAME_RE.test(value) && !/^[0-9]+$/.test(value.split(".").at(-1) ?? "");
}

export const HostName = z.string().max(253).refine(isHostName, "must be a host name");
