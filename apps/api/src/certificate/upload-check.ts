import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { getCACertificates } from "node:tls";
import type { CertificateUploadCheck } from "@portikus/contracts";

/**
 * The API's first look at an uploaded certificate (SPEC.md 20.1, 24.8),
 * with node:crypto, so the page can say at once which check failed. The
 * root job checks again with openssl and never trusts this one.
 */

export interface UploadRefusal {
	check: CertificateUploadCheck;
	message: string;
}

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const MAX_CHAIN = 10;

let systemRoots: X509Certificate[] | null = null;
function roots(): X509Certificate[] {
	if (!systemRoots) {
		systemRoots = [];
		for (const pem of getCACertificates("system")) {
			try {
				systemRoots.push(new X509Certificate(pem));
			} catch {
				// A store entry Node cannot parse cannot anchor a chain either.
			}
		}
	}
	return systemRoots;
}

function issuedBy(child: X509Certificate, parent: X509Certificate): boolean {
	return child.checkIssued(parent) && child.verify(parent.publicKey);
}

function spki(key: ReturnType<typeof createPublicKey>): Buffer {
	return key.export({ type: "spki", format: "der" });
}

/**
 * Check one upload: leaf first, then its chain. `privateKey` is absent when
 * the stored key is kept, and then only the job can compare them. Messages
 * never quote the upload. `names` are the host names the certificate must
 * cover, `*.<suffix>` for a wildcard. `trusted` replaces the system store in tests.
 */
export function checkUpload(
	upload: { certificate: string; privateKey?: string | undefined },
	names: string[],
	now: Date = new Date(),
	trusted: X509Certificate[] = roots(),
): UploadRefusal | null {
	const chain = readChain(upload.certificate);
	if (!chain) {
		return {
			check: "certificate-readable",
			message: "The certificate is not a readable PEM certificate.",
		};
	}
	const leaf = chain[0] as X509Certificate;
	return (
		(upload.privateKey === undefined ? null : checkKey(upload.privateKey, leaf)) ??
		checkChain(leaf, chain, trusted) ??
		checkDates(chain, now) ??
		checkNames(leaf, names)
	);
}

/** Every certificate in the upload, leaf first, or null when none can be read. */
function readChain(certificate: string): X509Certificate[] | null {
	const pems = certificate.match(PEM_CERTIFICATE) ?? [];
	if (pems.length === 0) return null;
	try {
		return pems.map((pem) => new X509Certificate(pem));
	} catch {
		return null;
	}
}

function checkKey(privateKey: string, leaf: X509Certificate): UploadRefusal | null {
	let key: ReturnType<typeof createPrivateKey>;
	try {
		key = createPrivateKey(privateKey);
	} catch {
		return {
			check: "key-readable",
			message: "The private key is not a readable, unencrypted PEM key.",
		};
	}
	if (!spki(createPublicKey(key)).equals(spki(leaf.publicKey))) {
		return {
			check: "key-matches",
			message: "The private key does not match the certificate.",
		};
	}
	return null;
}

function checkChain(
	leaf: X509Certificate,
	chain: X509Certificate[],
	trusted: X509Certificate[],
): UploadRefusal | null {
	if (reachesRoot(leaf, chain, trusted)) return null;
	return {
		check: "chain-complete",
		message:
			"The chain does not reach a trusted root. Include every intermediate certificate after the site certificate.",
	};
}

/**
 * Walk up from the leaf: each step must be signed by an included
 * certificate, until one is self-signed or a system root signed it.
 */
function reachesRoot(
	leaf: X509Certificate,
	chain: X509Certificate[],
	trusted: X509Certificate[],
): boolean {
	let current = leaf;
	for (let step = 0; step < MAX_CHAIN; step++) {
		if (trusted.some((root) => issuedBy(current, root))) return true;
		if (issuedBy(current, current)) return true;
		const parent = chain.find((c) => c !== current && issuedBy(current, c));
		if (!parent) return false;
		current = parent;
	}
	return false;
}

function checkDates(chain: X509Certificate[], now: Date): UploadRefusal | null {
	for (const cert of chain) {
		if (new Date(cert.validFrom) > now || new Date(cert.validTo) < now) {
			return {
				check: "dates-valid",
				message: "A certificate in the upload is not yet valid or has expired.",
			};
		}
	}
	return null;
}

function checkNames(leaf: X509Certificate, names: string[]): UploadRefusal | null {
	// A wildcard is covered when any one name under it would be.
	const missing = names.filter((name) => {
		const host = name.startsWith("*.") ? `portikus-check${name.slice(1)}` : name;
		return leaf.checkHost(host) === undefined;
	});
	if (missing.length === 0) return null;
	return {
		check: "names-cover",
		message: `The certificate does not cover ${missing.join(" and ")}.`,
	};
}
