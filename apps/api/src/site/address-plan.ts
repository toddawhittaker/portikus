import type {
	AddressPlan,
	AddressSettings,
	CertificateStatusFile,
	SiteView,
} from "@portikus/contracts";

/**
 * What moving the site to a new host name or port changes (ADR 0059):
 * every address setup derives from it, the values an
 * administrator must paste into systems outside Portikus, and the running
 * workspaces that keep the old preview suffix until their next start.
 */

export interface RunningWorkspace {
	id: string;
	label: string;
	ownerName: string;
}

/** `https://host` with the port only when it is not 443, as setup writes PUBLIC_URL. */
function siteUrl({ host, port }: AddressSettings): string {
	return port === 443 ? `https://${host}` : `https://${host}:${port}`;
}

/** The Host header a browser sends for the address. */
export function hostHeader({ host, port }: AddressSettings): string {
	return port === 443 ? host : `${host}:${port}`;
}

/** The suffix after the move: `preview.<host>`, unless it was set by hand. */
export function nextPreviewSuffix(view: SiteView, host: string): string {
	return view.previewSuffixSetByHand ? view.previewSuffix : `preview.${host}`;
}

/** Whether a certificate's names cover `host`; a wildcard covers one label. */
export function namesCover(names: readonly string[], host: string): boolean {
	const wanted = host.toLowerCase();
	return names.some((raw) => {
		const name = raw.toLowerCase();
		if (name === wanted) return true;
		if (!name.startsWith("*.")) return false;
		const dot = wanted.indexOf(".");
		return dot > 0 && wanted.slice(dot + 1) === name.slice(2);
	});
}

/**
 * Whether the uploaded certificates in force cover the new site name and
 * its preview names. Only meaningful for the `files` source; an
 * unreadable status counts as not covering, because nothing proves it does.
 */
export function uploadsCover(
	status: CertificateStatusFile | null,
	host: string,
	previewSuffix: string,
): boolean {
	const settings = status?.settings;
	if (settings?.source !== "files") return false;
	const site = settings.site.certificate.names;
	const preview = settings.preview?.certificate.names ?? site;
	return (
		namesCover(site, host) && namesCover(preview, `portikus-check.${previewSuffix}`)
	);
}

/** Why the address cannot be planned at all, or null. */
export function addressRefusal(view: SiteView, target: AddressSettings): string | null {
	if (view.host === target.host && view.port === target.port) {
		return "This is already the site's address.";
	}
	const suffix = nextPreviewSuffix(view, target.host);
	// The site must never be a preview host (SPEC.md 14.3).
	if (target.host === suffix || target.host.endsWith(`.${suffix}`)) {
		return `The site cannot live under its own preview names (*.${suffix}).`;
	}
	return null;
}

const UPSTREAM_NAME = {
	entra: "Microsoft Entra",
	google: "Google",
	oidc: "the sign-in provider",
} as const;

function certificateNote(
	source: SiteView["certificateSource"],
	allowed: boolean,
	host: string,
	suffix: string,
): string {
	if (source === "internal") {
		return `Caddy's internal authority issues certificates for ${host} and *.${suffix} itself. Browsers that already trust its root certificate keep trusting the site.`;
	}
	if (source === "acme") {
		return `Caddy asks the ACME authority for a certificate for ${host} and *.${suffix} after the switch. Until it arrives the new address shows a certificate warning, so allow a few minutes before pressing Keep.`;
	}
	return allowed
		? `The uploaded certificate already covers ${host} and *.${suffix}.`
		: `The uploaded certificate does not cover ${host} and *.${suffix}. Upload one that does on the Certificate tab first.`;
}

/** Everything that follows from moving the site to `target`. */
export function planAddress(options: {
	view: SiteView;
	target: AddressSettings;
	/** The certificate status, read only when the source is uploaded files. */
	certificateStatus: CertificateStatusFile | null;
	running: RunningWorkspace[];
}): AddressPlan {
	const { view, target, certificateStatus, running } = options;
	const url = siteUrl(target);
	const dexIssuer = `${url}/dex`;
	const dexCallbackUrl = `${dexIssuer}/callback`;
	const previewSuffix = nextPreviewSuffix(view, target.host);
	const source = view.certificateSource;
	const allowed =
		source !== "files" || uploadsCover(certificateStatus, target.host, previewSuffix);
	const suffixChanges = previewSuffix !== view.previewSuffix;
	const lti = {
		loginUrl: `${url}/lti/login`,
		launchUrl: `${url}/lti/launch`,
		keysetUrl: `${url}/lti/jwks`,
	};

	const checklist = [
		`Before you apply, point ${target.host} and *.${previewSuffix} at this server in DNS.`,
	];
	if (target.port !== view.port) {
		checklist.push(
			`Open port ${target.port} in any firewall or port forward in front of this server. Portikus opens it on the server itself.`,
		);
	}
	if (
		view.provider === "entra" ||
		view.provider === "google" ||
		view.provider === "oidc"
	) {
		checklist.push(
			`In ${UPSTREAM_NAME[view.provider]}, add ${dexCallbackUrl} as a redirect address of the Portikus app registration. Keep the old one until you press Keep.`,
		);
	}
	checklist.push(
		`In each learning management system that launches Portikus, change the tool's login address to ${lti.loginUrl}, its launch and redirect address to ${lti.launchUrl}, and its keyset address to ${lti.keysetUrl}.`,
		`After the switch, open ${url}, sign in again and press Keep within 15 minutes.`,
		"Tell everyone the new address. Everyone is signed out, and old bookmarks and preview links stop working.",
	);

	return {
		siteUrl: url,
		dexIssuer,
		dexCallbackUrl,
		lti,
		previewSuffix,
		previewSuffixSetByHand: view.previewSuffixSetByHand,
		previewWildcard: `*.${previewSuffix}`,
		certificate: { source, allowed },
		workspacesKeepingOldSuffix: suffixChanges ? running : [],
		dnsNames: [target.host, `*.${previewSuffix}`],
		certificateNote: certificateNote(source, allowed, target.host, previewSuffix),
		checklist,
	};
}
