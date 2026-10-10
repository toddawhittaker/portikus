import { SiteView } from "@portikus/contracts";
import { readJson } from "../job-files.js";

/**
 * The install settings setup wrote for the page (ADR 0059). Null when the
 * file is missing, as on a development install or before the first setup,
 * or when it does not match the schema; the page then says the address and
 * sign-in settings are unavailable.
 */
export function readSiteView(path: string): Promise<SiteView | null> {
	return readJson(path, SiteView);
}
