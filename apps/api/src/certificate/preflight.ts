import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { ApiConfig } from "@portikus/config";
import type { CertificatePreflight, PreflightCheck } from "@portikus/contracts";

/**
 * Pre-flight for an ACME change (SPEC.md 20.1): the site and a sample
 * preview name resolve in DNS, and a nonce this API hands out comes back
 * from each name, which proves the name points at this server. For
 * HTTP-01 plain http on port 80 must answer too. Failures block HTTP-01
 * and only warn for DNS-01, whose certificate does not depend on them.
 * The probes start on this server, so a firewall that only blocks outside
 * traffic is left to the staging test.
 */

/** Caddy sends this path on the site, preview and port-80 hosts to the API. */
export const PREFLIGHT_PATH = "/.well-known/portikus-preflight/";
const NONCE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_BODY = 256;

/** Nonces handed out for probes; each lives a minute. */
export class NonceStore {
	private readonly nonces = new Map<string, number>();

	issue(now = Date.now()): string {
		for (const [nonce, expires] of this.nonces) {
			if (expires < now) this.nonces.delete(nonce);
		}
		const nonce = randomBytes(16).toString("hex");
		this.nonces.set(nonce, now + NONCE_TTL_MS);
		return nonce;
	}

	has(nonce: string, now = Date.now()): boolean {
		const expires = this.nonces.get(nonce);
		return expires !== undefined && expires >= now;
	}
}

export interface PreflightNet {
	/** Every A and AAAA address from DNS, skipping /etc/hosts; empty when none. */
	resolve(name: string): Promise<string[]>;
	/** GET `url` from `address`, sending the URL's host name; the body, or null on any failure. */
	probe(url: string, address: string): Promise<string | null>;
}

async function resolveAll(name: string): Promise<string[]> {
	const resolver = new Resolver({ timeout: PROBE_TIMEOUT_MS, tries: 2 });
	const [v4, v6] = await Promise.all([
		resolver.resolve4(name).catch(() => [] as string[]),
		resolver.resolve6(name).catch(() => [] as string[]),
	]);
	return [...v4, ...v6];
}

function probe(url: string, address: string): Promise<string | null> {
	const target = new URL(url);
	const secure = target.protocol === "https:";
	const options = {
		host: address,
		port: target.port || (secure ? 443 : 80),
		path: target.pathname,
		headers: { host: target.host },
		timeout: PROBE_TIMEOUT_MS,
		// The certificate may be the one being replaced; the nonce is the proof.
		...(secure ? { servername: target.hostname, rejectUnauthorized: false } : {}),
	};
	return new Promise((resolve) => {
		const request = (secure ? https : http).get(options, (response) => {
			if (response.statusCode !== 200) {
				response.resume();
				resolve(null);
				return;
			}
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				body += chunk;
				if (body.length > MAX_BODY) request.destroy();
			});
			response.on("end", () => resolve(body.trim()));
			response.on("error", () => resolve(null));
		});
		request.on("timeout", () => request.destroy());
		request.on("error", () => resolve(null));
	});
}

export const systemNet: PreflightNet = { resolve: resolveAll, probe };

export async function runPreflight(options: {
	config: ApiConfig;
	net: PreflightNet;
	nonces: NonceStore;
	mode: "dns01" | "http01";
}): Promise<CertificatePreflight> {
	const { config, net, nonces, mode } = options;
	const bad = mode === "http01" ? "failed" : "warning";
	const site = new URL(config.PUBLIC_URL);
	const nonce = nonces.issue();
	const sample = `portikus-check-${nonce.slice(0, 8)}.${config.PREVIEW_SUFFIX}`;
	const port = site.port ? `:${site.port}` : "";

	async function reaches(url: string, addresses: string[]): Promise<boolean> {
		if (addresses.length === 0) return false;
		const bodies = await Promise.all(addresses.map((a) => net.probe(url, a)));
		return bodies.every((body) => body === nonce);
	}

	const [siteAddresses, previewAddresses] = await Promise.all([
		net.resolve(site.hostname),
		net.resolve(sample),
	]);
	const path = `${PREFLIGHT_PATH}${nonce}`;
	const [siteReached, previewReached, port80] = await Promise.all([
		reaches(`https://${site.hostname}${port}${path}`, siteAddresses),
		reaches(`https://${sample}${port}${path}`, previewAddresses),
		mode === "http01"
			? reaches(`http://${site.hostname}${path}`, siteAddresses)
			: Promise.resolve(true),
	]);

	const checks: PreflightCheck[] = [
		siteAddresses.length > 0
			? { name: "dns-site", result: "passed", message: `${site.hostname} resolves.` }
			: {
					name: "dns-site",
					result: bad,
					message: `${site.hostname} does not resolve in DNS.`,
				},
		previewAddresses.length > 0
			? {
					name: "dns-preview",
					result: "passed",
					message: `Preview names such as ${sample} resolve.`,
				}
			: {
					name: "dns-preview",
					result: bad,
					message: `${sample} does not resolve in DNS. Add a wildcard record for *.${config.PREVIEW_SUFFIX}.`,
				},
		siteReached
			? {
					name: "reach-site",
					result: "passed",
					message: `${site.hostname} reaches this server.`,
				}
			: {
					name: "reach-site",
					result: bad,
					message: `${site.hostname} does not reach this server at every address DNS gives.`,
				},
		previewReached
			? {
					name: "reach-preview",
					result: "passed",
					message: `${sample} reaches this server.`,
				}
			: {
					name: "reach-preview",
					result: bad,
					message: `${sample} does not reach this server at every address DNS gives.`,
				},
	];
	if (mode === "http01") {
		checks.push(
			port80
				? {
						name: "http-port-80",
						result: "passed",
						message: `http://${site.hostname} answers on port 80.`,
					}
				: {
						name: "http-port-80",
						result: "failed",
						message: `http://${site.hostname} does not answer on port 80, which HTTP-01 needs.`,
					},
		);
	}
	return { ok: !checks.some((check) => check.result === "failed"), checks };
}
