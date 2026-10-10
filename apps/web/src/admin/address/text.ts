import type {
	AddressSettings,
	PreflightCheck,
	SiteJobCode,
	SiteJobView,
	SiteView,
} from "@portikus/contracts";

export const SOURCE_LABEL: Record<SiteView["certificateSource"], string> = {
	internal: "Caddy's internal authority",
	acme: "ACME (for example Let's Encrypt)",
	files: "Uploaded certificate",
};

export const CHECK_LABEL: Partial<Record<PreflightCheck["name"], string>> = {
	"dns-site": "The new name resolves",
	"dns-preview": "The new preview names resolve",
	"reach-site": "The new name points at this server",
	"reach-preview": "The new preview names point at this server",
};

/** `https://host`, with the port unless it is 443, as the browser shows it. */
export function addressText({ host, port }: AddressSettings): string {
	return port === 443 ? `https://${host}` : `https://${host}:${port}`;
}

const CODE_TEXT: Partial<Record<SiteJobCode, string>> = {
	not_apt_install: "This server was not installed with apt.",
	certificate_not_covering: "The uploaded certificate does not cover the new names.",
	reserved_port: "Portikus itself uses that port.",
	invalid_value: "The server refused the host name or port.",
	trial_open: "Another trial was open.",
	busy: "Another change was running.",
};

/** One plain sentence or two about the job, for the page and the status region. */
export function jobText(job: SiteJobView, target: AddressSettings | null): string {
	const to = target ? addressText(target) : "the new address";
	switch (job.state) {
		case "queued":
			return `The move to ${to} is waiting for the server to take it.`;
		case "running":
			return `Setup is moving the site to ${to}. This page loses its connection when the switch happens; then open the new address.`;
		case "trial":
			return `The site now answers at ${to} as a trial.`;
		case "kept":
			return `The site moved to ${to} and the change was kept.`;
		case "reverted":
			if (job.code === "trial_expired") {
				return `Nobody pressed Keep at ${to} in time, so the old address was put back.`;
			}
			if ((job.code as string | null) === "trial_superseded") {
				return "The trial ended because the settings were changed outside this page.";
			}
			if (job.code === "setup_failed") {
				return `Setup failed while moving to ${to}, so the old address was put back.`;
			}
			return `The move to ${to} was rolled back. The old address is in use.`;
		case "done":
			return `The change to ${to} finished.`;
		case "failed":
			return `The move to ${to} failed. ${
				(job.code && CODE_TEXT[job.code]) ?? "Nothing was changed."
			}`;
	}
}
